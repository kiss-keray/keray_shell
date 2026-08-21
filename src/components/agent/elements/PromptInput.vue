<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { copyToConversationTemp, discardConversationTempAttachment, writeBytesToConversationTemp } from "@/agent/conversation/attachments";
import { formatContextTokens, MAX_CONTEXT_WINDOW_TOKENS, MIN_CONTEXT_WINDOW_TOKENS } from "@/agent/config/schema";
import { estimateInputTokens, estimatePromptOptionTokens } from "@/agent/input";
import {
    ACCESS_MODE_OPTIONS,
    accessModeOption,
    getAgentRuntimeContext,
    setAgentAccessMode,
    setAgentCommandExecution,
    type AgentAccessMode,
    type AgentCommandExecution,
} from "@/agent/runtimeContext";
import { readClipboardImageFile } from "@/utils/project";
import { openOrFocusSkillsWindow } from "@/utils/window";
import ImageLightbox from "./ImageLightbox.vue";
import type {
    AgentAttachment,
    AgentContextSegment,
    AgentPromptSubmitOptions,
    AgentReasoningEffort,
    LangGraphAgent,
    AgentModelOption,
    AgentSkillOption,
    AgentContextUsage,
    AgentCompressionStatus,
} from "@/agent/types";

import { mimeFromFileName } from "@/agent/types";
import { estimateDraftConversationTokens } from "@/agent/context.js";

/** 粘贴图片单张上限；超过后不写入附件，避免把超大截图塞进视觉请求。 */
const MAX_PASTE_IMAGE_BYTES = 10 * 1024 * 1024;

defineOptions({ name: "AgentPromptInput" });

type PopoverName = "add" | "config" | "usage" | "access";
type ConfigSection = "model" | "reasoning" | "context-size";

const reasoningOptions: { value: AgentReasoningEffort; label: string; description: string }[] = [
    { value: "low", label: "低", description: "响应更快，适合直接任务" },
    { value: "medium", label: "中", description: "兼顾速度与可靠性" },
    { value: "high", label: "高", description: "充分分析复杂问题" },
];

// 输入框正文由本组件持有，不跟会话绑定；切标签时保留未发送内容，submit 后再清空。
const props = withDefaults(
    defineProps<{
        disabled?: boolean;
        loading?: boolean;
        agent?: LangGraphAgent;
        emptyMessage?: boolean;
        contextUsage?: AgentContextUsage;
        compressionStatus?: AgentCompressionStatus;
        compressionTitle?: string;
        compressionDisabled?: boolean;
    }>(),
    {
        disabled: false,
        loading: false,
        emptyMessage: false,
        compressionStatus: "idle",
        compressionTitle: "压缩上下文",
        compressionDisabled: false,
    },
);
const emit = defineEmits<{
    submit: [data: AgentPromptSubmitOptions];
    /** 运行中点击发送按钮时触发，由父组件中断当前流式输出。 */
    stop: [];
    /** 上下文用量弹层内点击压缩按钮时触发，由当前会话执行手动压缩。 */
    "compress-context": [];
}>();

const input = ref(""); // 输入框正文
const rootRef = ref<HTMLElement>(); // 根元素
const textareaRef = ref<HTMLTextAreaElement>(); // 文本区域
const activePopover = ref<PopoverName>(); // 活动弹出框
const activeConfigSection = ref<ConfigSection | null>(null); // 活动配置章节
const attachments = ref<AgentAttachment[]>([]); // 附件列表
const selectedSkillNames = ref<string[]>([]); // 选中的技能名称列表
const pendingOptionTokens = ref(0); // 尚未提交的技能指令和附件估算
const contextSliderValue = ref(MIN_CONTEXT_WINDOW_TOKENS); // 设置的上下文大小
const selectedModelId = ref(props.agent?.getSelectedModelId() ?? "");
const isComposing = ref(false); // 是否正在输入

const models = ref<AgentModelOption[]>([]); // 模型列表
const skills = ref<AgentSkillOption[]>([]); // 技能列表

/** 访问限制与执行通道是全局状态，输入区直接读写，不跟当前会话走。 */
const runtimeContext = getAgentRuntimeContext();
const currentAccessOption = computed(() => accessModeOption(runtimeContext.accessMode));
const selectedReasoningEffort = computed(() => props.agent?.getModelConfig().reasoningEffort ?? "high");
const selectedContextWindowTokens = computed(() => contextSliderValue.value);

const selectedModel = computed(() => models.value.find((item) => item.id === selectedModelId.value));
const reasoningLabel = computed(() => reasoningOptions.find((item) => item.value === selectedReasoningEffort.value)!.label);
const selectedModelMaxContextTokens = computed(() => selectedModel.value?.maxContextWindowTokens ?? MAX_CONTEXT_WINDOW_TOKENS);

/**
 * Agent 已经把系统提示、工具、技能目录和已提交历史算进 contextUsage。
 * 输入框草稿在这里按 HumanMessage JSON 估算后并入“对话”；显式选中技能只发送 load_skill 指令，正文要等工具结果进入历史；附件则按真实发送分支异步估算。
 */
const usageSegments = computed<AgentContextSegment[]>(() => {
    return (
        props.contextUsage?.segments.map((segment) => ({
            ...segment,
            tokens: segment.tokens + (segment.key === "conversation" ? pendingOptionTokens.value : 0),
        })) || []
    );
});
const usedTokens = computed(() => usageSegments.value.reduce((sum, item) => sum + item.tokens, 0));
/** 保留精确占比给圆环绘制，文字展示再单独取整，避免小占用量被静态图标误示为整圈。 */
const usageProgress = computed(() => {
    const val = selectedContextWindowTokens.value;
    return Math.min(100, Math.max(0, (usedTokens.value / Math.max(1, val)) * 100));
});
const usagePercent = computed(() => Math.round(usageProgress.value));
const compressionButton = computed(() => {
    if (props.compressionStatus === "running") return { icon: "mdi:loading", label: "压缩中" };
    if (props.compressionStatus === "compressed") return { icon: "mdi:check", label: "已压缩" };
    if (props.compressionStatus === "unchanged") return { icon: "mdi:information-outline", label: "无需压缩" };
    if (props.compressionStatus === "error") return { icon: "mdi:alert-circle-outline", label: "压缩失败" };
    return { icon: "mdi:archive-arrow-down-outline", label: "压缩上下文" };
});

watch(
    () => props.agent,
    (agent, _previousAgent, onCleanup) => {
        if (agent) {
            loadModelAndSkill();
            selectedModelId.value = agent.getSelectedModelId();
            contextSliderValue.value = agent.getModelConfig().contextWindowTokens ?? selectedModelMaxContextTokens;
            // Skills 管理窗口写入文件后 PromptManager 会热重载，这里同步刷新选择列表。
            onCleanup(agent.promptManager.onReload(loadModelAndSkill));
        }
    },
    { immediate: true },
);

watch(input, () => {
    void nextTick(resizeTextarea);
});
watch(
    [attachments, selectedSkillNames, () => input.value],
    async () => {
        pendingOptionTokens.value = await estimateInputTokens({
            content: input.value.trim(),
            attachments: [...attachments.value],
            skillNames: [...selectedSkillNames.value],
        });
    },
    { deep: true, immediate: true },
);

function loadModelAndSkill() {
    const _models = props.agent?.getModelsConfig().models;
    const _skills = props.agent?.listSkillOptions();
    models.value =
        _models?.map((item) => ({
            id: item.id,
            model: item.model,
            maxContextWindowTokens: item.maxContextWindowTokens,
        })) || [];
    skills.value =
        _skills?.map((item) => ({
            name: item.name,
            description: item.description,
            estimatedTokens: item.estimatedTokens,
        })) || [];
}

/** 收起添加菜单后再打开独立窗口，返回输入区时不会残留两层浮窗。 */
async function openSkillsManager() {
    activePopover.value = undefined;
    await openOrFocusSkillsWindow();
}

/** 切到高度自主或完全访问前先用 Prompt 确认对应风险；取消则保持原模式。 */
async function selectAccessMode(value: AgentAccessMode) {
    activePopover.value = undefined;
    if (value === runtimeContext.accessMode) return;
    const confirm = accessModeOption(value).confirm;
    if (confirm) {
        const confirmed = await showPrompt({
            title: confirm.title,
            message: confirm.message,
            confirmText: confirm.confirmText,
            cancelText: "取消",
            showInput: false,
            danger: confirm.danger,
            warning: confirm.warning,
        });
        if (confirmed === null) return;
    }
    await setAgentAccessMode(value);
}

function selectCommandExecution(value: AgentCommandExecution) {
    void setAgentCommandExecution(value);
}

function canSubmit(): boolean {
    return !props.disabled && !props.loading && Boolean(input.value.trim() || attachments.value.length);
}

function submit() {
    if (!canSubmit()) return;
    const question = input.value;
    emit("submit", {
        content: question,
        attachments: [...attachments.value],
        skillNames: [...selectedSkillNames.value],
    });
    // 文本已交给 Agent.submit；立刻清空，避免下一轮把同一段内容再发出去。
    input.value = "";
    // 本轮上下文已随 submit 交给父组件，清空可防止下一轮误重复附带。
    // 预览 URL 仍挂在已提交的附件对象上，对话气泡还能继续显示缩略图。
    attachments.value = [];
    selectedSkillNames.value = [];
    activePopover.value = undefined;
}

function onKeydown(event: KeyboardEvent) {
    const beforeIsComposing = isComposing.value;
    isComposing.value = event.isComposing;
    // 与常见 Agent 输入框一致：Enter 发送，Shift+Enter 保留换行。
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (beforeIsComposing) return;
    event.preventDefault();
    submit();
}

function resizeTextarea() {
    const textarea = textareaRef.value;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
}

function togglePopover(name: PopoverName) {
    activeConfigSection.value = null;
    activePopover.value = activePopover.value === name ? undefined : name;
}

/** 统一配置弹窗保持打开，只切换二级选项，避免输入框里堆叠多个配置入口。 */
function showConfigSection(section: ConfigSection) {
    activeConfigSection.value = section;
}

function upsertAttachments(next: AgentAttachment[]) {
    const byPath = new Map(attachments.value.map((item) => [item.path, item]));
    for (const item of next) byPath.set(item.path, item);
    attachments.value = [...byPath.values()];
}

async function chooseLocalFiles() {
    activePopover.value = undefined;
    const selected = await open({ title: "选择本地文件", multiple: true, directory: false });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const next: AgentAttachment[] = [];
    for (const path of paths) {
        const name = path.split(/[\\/]/).at(-1) || path;
        try {
            // 会话 JSON 不能记用户原路径；选中后立刻拷进 conversation/temp。
            const copied = await copyToConversationTemp(path, name);
            const mimeType = mimeFromFileName(name);
            next.push({
                path: copied.path,
                name,
                size: copied.size,
                mimeType,
                kind: mimeType ? "image" : "file",
            });
        } catch (error) {
            showToast(error instanceof Error ? error.message : `复制 ${name} 失败`, "error");
        }
    }
    if (next.length) upsertAttachments(next);
}

/**
 * 从剪贴板事件取出图片。优先 files（从访达复制文件），再看 items（截图原始位图）。
 */
function collectPasteImageFiles(event: ClipboardEvent): File[] {
    const data = event.clipboardData;
    if (!data) return [];
    const fromFiles = Array.from(data.files).filter((file) => isSupportedImageMime(file.type));
    if (fromFiles.length) return fromFiles;
    const fromItems: File[] = [];
    for (const item of Array.from(data.items)) {
        if (item.kind !== "file" || !isSupportedImageMime(item.type)) continue;
        const file = item.getAsFile();
        if (file) fromItems.push(file);
    }
    return fromItems;
}

function isSupportedImageMime(mime: string): boolean {
    return mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg" || mime === "image/gif" || mime === "image/webp";
}

function extFromMime(mime: string): string {
    if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
    if (mime === "image/gif") return "gif";
    if (mime === "image/webp") return "webp";
    return "png";
}

/** 把粘贴得到的 File 写到会话 temp 目录，作为本轮附件；同路径去重。 */
async function addImageFiles(files: File[]) {
    try {
        const next: AgentAttachment[] = [];
        for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (!bytes.length) {
                showToast("粘贴的图片是空的", "warning");
                continue;
            }
            if (bytes.length > MAX_PASTE_IMAGE_BYTES) {
                showToast(`图片超过 ${Math.round(MAX_PASTE_IMAGE_BYTES / 1024 / 1024)}MB，无法附加`, "warning");
                continue;
            }
            const mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type || "image/png";
            const name = file.name?.trim() && file.name !== "image.png" ? file.name : `粘贴图片.${extFromMime(mimeType)}`;
            try {
                const saved = await writeBytesToConversationTemp(bytes, name);
                next.push({
                    path: saved.path,
                    name,
                    size: saved.size,
                    kind: "image",
                    mimeType,
                    previewUrl: URL.createObjectURL(file),
                });
            } catch (error) {
                showToast(error instanceof Error ? error.message : "保存粘贴图片失败", "error");
            }
        }
        if (next.length) upsertAttachments(next);
    } catch (error) {
        showToast(error instanceof Error ? error.message : "粘贴图片失败", "error");
    }
}

async function onPaste(event: ClipboardEvent) {
    if (props.disabled) return;
    const files = collectPasteImageFiles(event);
    if (files.length) {
        // 拦住默认粘贴，避免 textarea 出现乱码或文件路径。
        event.preventDefault();
        await addImageFiles(files);
        return;
    }
    // WebView 有时拿不到位图；没有文字时先拦住默认行为，再走原生 arboard。
    const hasText = Boolean(event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text/html"));
    if (hasText) return;
    event.preventDefault();
    const native = await readClipboardImageFile();
    if (native) await addImageFiles([native]);
}

function toggleSkill(name: string) {
    selectedSkillNames.value = selectedSkillNames.value.includes(name)
        ? selectedSkillNames.value.filter((item) => item !== name)
        : [...selectedSkillNames.value, name];
    activePopover.value = undefined;
}

function selectModel(modelId: string) {
    selectedModelId.value = modelId;
    props.agent?.selectModel(modelId, props.emptyMessage);
    activePopover.value = undefined;
}

function selectReasoning(value: AgentReasoningEffort) {
    props.agent?.setReasoningEffort(value, props.emptyMessage);
    activePopover.value = undefined;
}

function updateContextSlider(event: Event) {
    contextSliderValue.value = Number((event.target as HTMLInputElement).value);
}

function commitContextSlider() {
    // 新对话时才保存模型配置
    props.agent?.setContextWindowTokens(contextSliderValue.value, props.emptyMessage);
}

function removeAttachment(path: string) {
    const removed = attachments.value.find((item) => item.path === path);
    attachments.value = attachments.value.filter((item) => item.path !== path);
    // 还没发送的附件从输入区拿掉时，对应 temp 副本一并删掉。
    if (removed) void discardConversationTempAttachment(removed);
}

/** 输入区缩略图点击后放大查看。 */
const imagePreview = ref<{ src: string; alt: string } | null>(null);

function openAttachmentPreview(file: AgentAttachment) {
    if (!file.previewUrl) return;
    imagePreview.value = { src: file.previewUrl, alt: file.name };
}

function formatTokens(value: number): string {
    return formatContextTokens(value);
}

function segmentWidth(segment: AgentContextSegment): string {
    const maxTokens = selectedContextWindowTokens.value;
    return `${Math.max(segment.tokens > 0 ? 0.45 : 0, (segment.tokens / Math.max(1, maxTokens)) * 100)}%`;
}

function closeOnOutsidePointer(event: PointerEvent) {
    if (!rootRef.value?.contains(event.target as Node)) activePopover.value = undefined;
}

onMounted(() => {
    document.addEventListener("pointerdown", closeOnOutsidePointer);
});
onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", closeOnOutsidePointer);
    // 关掉面板时清掉未发送的 temp 附件，避免 conversation/temp 留下孤儿文件。
    for (const file of attachments.value) void discardConversationTempAttachment(file);
});
</script>

<template>
    <form ref="rootRef" class="ai-prompt-input" @submit.prevent="submit" @paste="onPaste">
        <!-- 访问限制菜单挂在整个输入框上，向上弹出，避免盖住输入区。 -->
        <div v-if="activePopover === 'access'" class="ai-prompt-popover ai-access-popover">
            <p class="ai-access-popover-title">应如何批准 Agent 操作?</p>
            <button
                v-for="item in ACCESS_MODE_OPTIONS"
                :key="item.value"
                type="button"
                class="ai-menu-item"
                :class="{ [`is-${item.tone}`]: item.tone !== 'default' }"
                @click="selectAccessMode(item.value)"
            >
                <Icon :icon="item.icon" />
                <span
                    ><strong>{{ item.label }}</strong
                    ><small>{{ item.description }}</small></span
                >
                <Icon v-if="runtimeContext.accessMode === item.value" icon="mdi:check" class="ai-menu-check" />
            </button>
        </div>

        <div class="ai-prompt-header">
            <!-- 左：全局访问限制；右：全局命令执行通道。两项都写入 agent-settings.json，对所有会话生效。 -->
            <div class="ai-prompt-control">
                <button
                    type="button"
                    class="ai-access-trigger"
                    :class="{
                        [`is-${currentAccessOption.tone}`]: currentAccessOption.tone !== 'default',
                    }"
                    :title="currentAccessOption.description"
                    :aria-expanded="activePopover === 'access'"
                    @click="togglePopover('access')"
                >
                    <Icon :icon="currentAccessOption.icon" />
                    <span>{{ currentAccessOption.shortLabel }}</span>
                </button>
            </div>

            <div class="ai-exec-switch" role="radiogroup" aria-label="命令执行方式">
                <button
                    type="button"
                    role="radio"
                    :aria-checked="runtimeContext.commandExecution === 'silent'"
                    :class="{ active: runtimeContext.commandExecution === 'silent' }"
                    title="后台执行命令，不写入当前终端"
                    @click="selectCommandExecution('silent')"
                >
                    <Icon icon="mdi:eye-off-outline" />
                    <span>静默</span>
                </button>
                <button
                    type="button"
                    role="radio"
                    :aria-checked="runtimeContext.commandExecution === 'visual'"
                    :class="{ active: runtimeContext.commandExecution === 'visual' }"
                    title="把命令打到当前终端，可视化执行过程"
                    @click="selectCommandExecution('visual')"
                >
                    <Icon icon="mdi:eye-outline" />
                    <span>可视化</span>
                </button>
            </div>
        </div>

        <div v-if="attachments.length || selectedSkillNames.length" class="ai-prompt-chips">
            <span
                v-for="file in attachments"
                :key="file.path"
                class="ai-prompt-chip"
                :class="{
                    'is-image': file.kind === 'image',
                    'is-zoomable': Boolean(file.previewUrl),
                }"
                :title="file.previewUrl ? `查看 ${file.name}` : undefined"
                @click="openAttachmentPreview(file)"
            >
                <img v-if="file.previewUrl" :src="file.previewUrl" :alt="file.name" />
                <Icon v-else :icon="file.kind === 'image' ? 'mdi:image-outline' : 'mdi:file-outline'" />
                <span>{{ file.name }}</span>
                <button type="button" :title="`移除 ${file.name}`" @click.stop="removeAttachment(file.path)">
                    <Icon icon="mdi:close" />
                </button>
            </span>
            <span v-for="skill in selectedSkillNames" :key="skill" class="ai-prompt-chip is-skill">
                <Icon icon="mdi:puzzle-outline" />
                <span>{{ skill }}</span>
                <button type="button" :title="`移除技能 ${skill}`" @click="toggleSkill(skill)">
                    <Icon icon="mdi:close" />
                </button>
            </span>
        </div>

        <textarea
            ref="textareaRef"
            v-model="input"
            rows="1"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="向 Agent 描述你想完成的任务…"
            :disabled="disabled"
            @focus="activePopover = undefined"
            @input="resizeTextarea"
            @keydown="onKeydown"
        ></textarea>

        <div class="ai-prompt-toolbar">
            <div class="ai-prompt-toolbar-left">
                <div class="ai-prompt-control">
                    <button
                        type="button"
                        class="ai-icon-button"
                        title="添加文件或技能"
                        :aria-expanded="activePopover === 'add'"
                        @click="togglePopover('add')"
                    >
                        <Icon icon="mdi:plus" />
                    </button>
                    <div v-if="activePopover === 'add'" class="ai-prompt-popover ai-add-popover">
                        <button type="button" class="ai-menu-item" @click="chooseLocalFiles">
                            <Icon icon="mdi:paperclip" />
                            <span><strong>选择本地文件</strong><small>将文本内容附加到本轮对话</small></span>
                        </button>
                        <div class="ai-menu-divider"></div>
                        <p class="ai-menu-label">选择技能</p>
                        <button
                            v-for="skill in skills"
                            :key="skill.name"
                            type="button"
                            class="ai-menu-item"
                            @click="toggleSkill(skill.name)"
                        >
                            <Icon icon="mdi:puzzle-outline" />
                            <span
                                ><strong>{{ skill.name }}</strong
                                ><small>{{ skill.description }}</small></span
                            >
                            <Icon v-if="selectedSkillNames.includes(skill.name)" icon="mdi:check" class="ai-menu-check" />
                        </button>
                        <p v-if="!skills.length" class="ai-menu-empty">当前没有可用技能</p>
                        <div class="ai-menu-divider"></div>
                        <button type="button" class="ai-menu-item" @click="openSkillsManager">
                            <Icon icon="mdi:lightning-bolt-outline" />
                            <span><strong>管理 Skills</strong><small>新建、编辑或删除用户 Skills</small></span>
                            <Icon icon="mdi:open-in-new" class="ai-menu-check" />
                        </button>
                    </div>
                </div>

                <div class="ai-prompt-control ai-config-control">
                    <button
                        type="button"
                        class="ai-selector-button ai-config-button"
                        :aria-expanded="activePopover === 'config'"
                        @click="togglePopover('config')"
                    >
                        <span>{{ selectedModel?.model ?? "选择模型" }}</span>
                        <strong>{{ reasoningLabel }}</strong>
                        <Icon icon="mdi:chevron-down" />
                    </button>
                    <div v-if="activePopover === 'config'" class="ai-config-flyout">
                        <div class="ai-prompt-popover ai-config-popover">
                            <button
                                type="button"
                                class="ai-config-row"
                                :class="{ active: activeConfigSection === 'model' }"
                                @mouseover="showConfigSection('model')"
                            >
                                <strong>模型</strong><span>{{ selectedModel?.model ?? "选择模型" }}</span
                                ><Icon icon="mdi:chevron-right" />
                            </button>
                            <button
                                type="button"
                                class="ai-config-row"
                                :class="{ active: activeConfigSection === 'reasoning' }"
                                @mouseover="showConfigSection('reasoning')"
                            >
                                <strong>推理强度</strong><span>{{ reasoningLabel }}</span
                                ><Icon icon="mdi:chevron-right" />
                            </button>
                            <button
                                type="button"
                                class="ai-config-row"
                                :class="{ active: activeConfigSection === 'context-size' }"
                                @mouseover="showConfigSection('context-size')"
                            >
                                <strong>上下文大小</strong><span>{{ formatTokens(contextSliderValue) }}</span
                                ><Icon icon="mdi:chevron-right" />
                            </button>
                        </div>

                        <div v-if="activeConfigSection" class="ai-prompt-popover ai-config-submenu">
                            <template v-if="activeConfigSection === 'model'">
                                <p class="ai-menu-label">选择模型</p>
                                <button
                                    v-for="item in models"
                                    :key="item.id"
                                    type="button"
                                    class="ai-menu-item is-compact"
                                    @click="selectModel(item.id)"
                                >
                                    <span
                                        ><strong>{{ item.model }}</strong></span
                                    >
                                    <Icon v-if="item.id === selectedModelId" icon="mdi:check" class="ai-menu-check" />
                                </button>
                            </template>
                            <template v-else-if="activeConfigSection === 'reasoning'">
                                <p class="ai-menu-label">选择推理强度</p>
                                <button
                                    v-for="item in reasoningOptions"
                                    :key="item.value"
                                    type="button"
                                    class="ai-menu-item"
                                    @click="selectReasoning(item.value)"
                                >
                                    <span
                                        ><strong>{{ item.label }}</strong
                                        ><small>{{ item.description }}</small></span
                                    >
                                    <Icon v-if="item.value === selectedReasoningEffort" icon="mdi:check" class="ai-menu-check" />
                                </button>
                            </template>
                            <template v-else>
                                <div class="ai-context-slider">
                                    <div class="ai-context-slider-header">
                                        <span>上下文大小</span><strong>{{ formatTokens(contextSliderValue) }} Tokens</strong>
                                    </div>
                                    <input
                                        :value="contextSliderValue"
                                        type="range"
                                        :min="MIN_CONTEXT_WINDOW_TOKENS"
                                        :max="selectedModelMaxContextTokens"
                                        step="1000"
                                        :disabled="selectedContextWindowTokens <= MIN_CONTEXT_WINDOW_TOKENS"
                                        aria-label="上下文大小"
                                        autocomplete="off"
                                        autocapitalize="off"
                                        autocorrect="off"
                                        spellcheck="false"
                                        @input="updateContextSlider"
                                        @change="commitContextSlider"
                                        @keydown.stop=""
                                    />
                                    <div class="ai-context-slider-limits">
                                        <span>最小 {{ formatTokens(MIN_CONTEXT_WINDOW_TOKENS) }}</span
                                        ><span>最大 {{ formatTokens(selectedModelMaxContextTokens) }}</span>
                                    </div>
                                    <p v-if="selectedModelMaxContextTokens <= MIN_CONTEXT_WINDOW_TOKENS" class="ai-context-slider-hint">
                                        当前模型最大上下文为
                                        {{ formatTokens(MIN_CONTEXT_WINDOW_TOKENS) }}，无法继续增大。
                                    </p>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>
            </div>

            <div class="ai-prompt-toolbar-right">
                <div class="ai-prompt-control ai-context-control">
                    <button
                        type="button"
                        class="ai-icon-button ai-context-button"
                        :title="`查看当前上下文信息，已使用 ${usagePercent}%`"
                        :aria-label="`查看当前上下文信息，已使用 ${usagePercent}%`"
                        :aria-expanded="activePopover === 'usage'"
                        @click="togglePopover('usage')"
                    >
                        <svg class="ai-context-ring" viewBox="0 0 20 20" aria-hidden="true">
                            <circle class="ai-context-ring-track" cx="10" cy="10" r="7" pathLength="100" />
                            <circle
                                class="ai-context-ring-value"
                                cx="10"
                                cy="10"
                                r="7"
                                pathLength="100"
                                :stroke-dasharray="`${usageProgress} 100`"
                            />
                        </svg>
                    </button>
                    <section v-if="activePopover === 'usage'" class="ai-context-panel" aria-label="上下文用量">
                        <header>
                            <h3>上下文用量</h3>
                            <div class="ai-context-header-actions">
                                <!-- 手动压缩只收拢模型记忆，完整 UI 聊天记录不会删除。 -->
                                <button
                                    type="button"
                                    class="ai-context-compress-button"
                                    :class="compressionStatus"
                                    :title="compressionTitle"
                                    :aria-label="compressionTitle"
                                    :aria-busy="compressionStatus === 'running'"
                                    :disabled="compressionDisabled"
                                    @click="emit('compress-context')"
                                >
                                    <Icon
                                        :icon="compressionButton.icon"
                                        :class="{ 'app-loading-spin': compressionStatus === 'running' }"
                                    />
                                    <span>{{ compressionButton.label }}</span>
                                </button>
                                <button class="ai-context-close-button" type="button" title="关闭" @click="activePopover = undefined">
                                    <Icon icon="mdi:close" />
                                </button>
                            </div>
                        </header>
                        <div class="ai-context-summary">
                            <strong>{{ usagePercent }}% 预计使用</strong
                            ><span>约 {{ formatTokens(usedTokens) }} / {{ formatTokens(selectedContextWindowTokens) }} Tokens</span>
                        </div>
                        <div class="ai-context-bar" aria-hidden="true">
                            <span
                                v-for="segment in usageSegments"
                                :key="segment.key"
                                :class="`is-${segment.key}`"
                                :style="{ width: segmentWidth(segment) }"
                            ></span>
                        </div>
                        <ul class="ai-context-list">
                            <li v-for="segment in usageSegments" :key="segment.key">
                                <span class="ai-context-swatch" :class="`is-${segment.key}`"></span><span>{{ segment.label }}</span
                                ><strong>{{ formatTokens(segment.tokens) }}</strong>
                            </li>
                        </ul>
                    </section>
                </div>

                <!-- 运行中发送按钮切换为停止：type 改为 button 避免触发表单提交，点击只向上发 stop 事件。 -->
                <button
                    class="ai-send-button"
                    :class="{ 'is-stop': loading }"
                    :type="loading ? 'button' : 'submit'"
                    :disabled="!loading && !canSubmit()"
                    :title="loading ? '停止生成' : '发送'"
                    @click="loading ? emit('stop') : undefined"
                >
                    <Icon :icon="loading ? 'mdi:stop' : 'mdi:arrow-up'" />
                </button>
            </div>
        </div>
        <ImageLightbox :src="imagePreview?.src" :alt="imagePreview?.alt" @close="imagePreview = null" />
    </form>
</template>

<style scoped lang="scss">
.ai-prompt-input {
    position: relative;
    display: flex;
    width: min(100%, 920px);
    margin: 0 auto;
    padding: 12px 8px;
    border-radius: 18px;
    box-sizing: border-box;
    flex-direction: column;
    gap: 8px;
    .ai-prompt-header {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }
    textarea {
        width: 100%;
        min-height: 25px;
        max-height: 150px;
        padding: 0 4px;
        resize: none;
        border: 0;
        outline: 0;
        background: transparent;
        color: inherit;
        box-sizing: border-box;
        font: inherit;
        line-height: 1.55;
    }
}
.ai-prompt-chips,
.ai-prompt-toolbar,
.ai-prompt-toolbar-left,
.ai-prompt-toolbar-right,
.ai-prompt-chip {
    display: flex;
    align-items: center;
}
.ai-prompt-chips {
    flex-wrap: wrap;
    gap: 6px;
}
.ai-prompt-chip {
    max-width: 260px;
    gap: 5px;
    padding: 4px 6px 4px 8px;
    border-radius: 8px;
    font-size: var(--font-size-xs);
    > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    img {
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        object-fit: cover;
        border-radius: 4px;
    }
    button {
        display: inline-flex;
        padding: 1px;
        border: 0;
        background: transparent;
        cursor: pointer;
    }
    &.is-zoomable {
        cursor: zoom-in;
    }
}
.ai-prompt-toolbar {
    min-width: 0;
    justify-content: space-between;
    gap: 8px;
}
.ai-prompt-toolbar-left,
.ai-prompt-toolbar-right {
    min-width: 0;
    gap: 5px;
}
.ai-prompt-control {
    position: relative;
}
/* 用量弹窗以整个输入框为定位边界，宽度不再受图标容器或视口尺寸误导。 */
.ai-context-control {
    position: static;
}
.ai-icon-button,
.ai-selector-button,
.ai-send-button {
    display: inline-flex;
    min-width: 30px;
    height: 30px;
    align-items: center;
    justify-content: center;
    border: 0;
    cursor: pointer;
}
.ai-icon-button {
    width: 30px;
    padding: 0;
    border-radius: 9px;
    font-size: 18px;
}
.ai-access-trigger {
    display: inline-flex;
    max-width: 148px;
    height: 26px;
    align-items: center;
    gap: 5px;
    padding: 0 8px 0 6px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-xs);
    > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    > svg {
        flex: 0 0 auto;
        font-size: 15px;
    }
}
.ai-access-popover {
    /* 相对整个输入框向上弹出，四档权限在输入区上方选择。 */
    left: 12px;
    bottom: calc(100% + 8px);
    width: 340px;
}
.ai-access-popover-title {
    margin: 4px 8px 8px;
    font-size: var(--font-size-sm);
    font-weight: 600;
}
.ai-exec-switch {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 2px;
    border-radius: 8px;
    button {
        display: inline-flex;
        height: 22px;
        align-items: center;
        gap: 4px;
        padding: 0 7px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
        font: inherit;
        font-size: var(--font-size-xs);
        white-space: nowrap;
        > svg {
            font-size: 14px;
        }
    }
}
.ai-context-ring {
    width: 20px;
    height: 20px;
    overflow: visible;
    fill: none;
    transform: rotate(-90deg);
    circle {
        stroke-width: 2.5;
    }
}
.ai-context-ring-value {
    stroke-linecap: round;
}
.ai-selector-button {
    max-width: 190px;
    gap: 3px;
    padding: 0 7px;
    border-radius: 8px;
    font-size: var(--font-size-xs);
    > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}
.ai-config-button {
    max-width: 220px;
    strong {
        flex: 0 0 auto;
        font-size: inherit;
        font-weight: 500;
    }
}
.ai-send-button {
    width: 32px;
    flex: 0 0 32px;
    border-radius: 10px;
}
.ai-prompt-popover,
.ai-context-panel {
    position: absolute;
    z-index: 30;
    bottom: calc(100% + 10px);
    padding: 7px;
    border-radius: 12px;
    box-sizing: border-box;
}
.ai-prompt-popover {
    left: 0;
    width: 280px;
    max-height: min(380px, 60vh);
    overflow-y: auto;
}
.ai-config-flyout {
    position: absolute;
    z-index: 30;
    bottom: calc(100% + 10px);
    /* 以触发按钮右边缘为锚点，让“二级选项 + 主配置”整体向 AgentPanel 左侧展开。 */
    right: 0;
    left: auto;
    display: flex;
    max-width: calc(100vw - 32px);
    align-items: flex-end;
    flex-direction: row;
    gap: 8px;
    .ai-prompt-popover {
        position: static;
        flex: 0 0 auto;
    }
}
.ai-config-popover {
    // 主配置弹窗固定在右侧，避免二级选项切换时两个面板互换位置。
    order: 2;
    width: 260px;
}
.ai-config-submenu {
    // 二级选项弹窗固定在主配置弹窗左侧，与 Codex 的层级菜单方向一致。
    order: 1;
    width: 280px;
}
.ai-config-row {
    display: grid;
    width: 100%;
    min-height: 38px;
    grid-template-columns: minmax(76px, auto) minmax(0, 1fr) 18px;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    strong {
        font-size: var(--font-size-sm);
        font-weight: 600;
    }
    span {
        overflow: hidden;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}
.ai-menu-label,
.ai-menu-empty {
    margin: 5px 8px;
    font-size: var(--font-size-xs);
}
.ai-menu-item {
    display: flex;
    width: 100%;
    min-height: 38px;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
    > svg:first-child {
        flex: 0 0 auto;
        font-size: 17px;
    }
    > span {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
        gap: 2px;
    }
    strong,
    small {
        overflow: hidden;
        text-overflow: ellipsis;
    }
    strong {
        font-size: var(--font-size-sm);
        font-weight: 500;
    }
    small {
        display: -webkit-box;
        font-size: var(--font-size-xs);
        line-height: 1.35;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }
    &.is-compact {
        min-height: 34px;
    }
}
.ai-menu-check {
    flex: 0 0 auto;
}
.ai-menu-divider {
    height: 1px;
    margin: 5px 3px;
}
.ai-context-slider {
    display: grid;
    gap: 12px;
    padding: 10px 9px 8px;
    box-sizing: border-box;
    input[type="range"] {
        width: 100%;
        margin: 0;
        cursor: pointer;
        &:disabled {
            cursor: default;
        }
    }
}
.ai-context-slider-header,
.ai-context-slider-limits {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}
.ai-context-slider-header {
    font-size: var(--font-size-sm);
    strong {
        font-weight: 600;
    }
}
.ai-context-slider-limits,
.ai-context-slider-hint {
    font-size: var(--font-size-xs);
}
.ai-context-slider-hint {
    margin: -4px 0 0;
    line-height: 1.4;
}
.ai-context-panel {
    right: 12px;
    /* 24px 对应输入框左右内边距，确保窄面板下弹窗始终完整落在父级内容区。 */
    width: min(480px, calc(100% - 24px));
    bottom: 52px;
    padding: 16px;
    header,
    .ai-context-summary,
    .ai-context-list li {
        display: flex;
        align-items: center;
    }
    header {
        justify-content: space-between;
        h3 {
            margin: 0;
            font-size: var(--font-size-lg);
            font-weight: 500;
        }
    }
}
.ai-context-header-actions,
.ai-context-compress-button,
.ai-context-close-button {
    display: inline-flex;
    align-items: center;
}
.ai-context-header-actions {
    gap: 8px;
    margin-left: auto;
}
.ai-context-compress-button {
    height: 28px;
    gap: 5px;
    padding: 0 9px;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-xs);
    > svg {
        font-size: 15px;
    }
    &:disabled {
        cursor: not-allowed;
        opacity: 0.45;
    }
    &.running:disabled {
        /* 运行态虽然禁止重复点击，但仍应保持清晰，避免视觉上像一个不可用操作。 */
        cursor: progress;
        opacity: 1;
    }
}
.ai-context-close-button {
    padding: 3px;
    border: 0;
    background: transparent;
    cursor: pointer;
}
.ai-context-summary {
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
    font-size: var(--font-size-sm);
    strong {
        font-weight: 500;
    }
}
.ai-context-bar {
    display: flex;
    height: 7px;
    margin: 9px 0 15px;
    overflow: hidden;
    gap: 1px;
    border-radius: 999px;
}
.ai-context-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    li {
        gap: 9px;
        font-size: var(--font-size-sm);
        > span:nth-child(2) {
            flex: 1;
        }
        strong {
            font-weight: 400;
        }
    }
}
.ai-context-swatch {
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    border-radius: 3px;
}
@media (max-width: 720px) {
    .ai-config-button {
        max-width: 170px;
    }
    .ai-config-flyout {
        width: min(280px, calc(100vw - 32px));
        flex-direction: column;
        .ai-prompt-popover {
            width: 100%;
        }
    }
    .ai-config-popover,
    .ai-config-submenu {
        // 窄窗口改为上下排列时恢复自然阅读顺序：主配置在上、二级选项在下。
        order: initial;
    }
}
</style>
