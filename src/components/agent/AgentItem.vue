<script setup lang="ts">
import { StickToBottom, type SpringAnimation } from "vue-stick-to-bottom";
import { useAgent } from "@/agent/useAgent";
import { ConversationEmptyState, ImageLightbox, Loader, Message, MessageResponse, Reasoning } from "./elements";
import { useCopyFeedback } from "./elements/useCopyFeedback";
import type {
    AgentChatMessage,
    AgentCompressionMessage,
    AgentCompressionStatus,
    AgentContextMemory,
    AgentInputMessage,
    AgentNoticeMessage,
    AgentPromptSubmitOptions,
    AgentResponseMessage,
} from "@/agent/types";

import { resolveAgentTimeline } from "@/agent/types";

defineOptions({ name: "AgentItem" });

const emit = defineEmits<{
    (e: "change", messages: AgentChatMessage[], status: boolean, contextMemory: AgentContextMemory): void;
}>();

const props = defineProps<{
    visible: boolean;
    servers: ChannelInstance[];
    threadId: string;
    history: AgentChatMessage[];
    contextMemory?: AgentContextMemory;
}>();

const messages = ref<AgentChatMessage[]>([...props.history]);

// AgentPanel 只负责展示；Agent 生命周期、会话状态和流事件消费统一交给 composable。
const agentProxy = useAgent(props.servers, props.threadId, messages.value, props.contextMemory);
const { agent, loading, submit, stop, initialized, contextMemory: currentContextMemory, compressionState } = agentProxy;

const { copied: messageCopied, copy: copyMessageText } = useCopyFeedback();

const copiedMessageId = ref("");

const initial = ref<SpringAnimation | ScrollBehavior>("instant");

const stickRef = ref<InstanceType<typeof StickToBottom>>();

const submitError = ref<string | null>(null);

watch(loading, (flag) => {
    // 一次对话完成才出发message更新保存
    if (flag) {
        stickRef.value?.scrollToBottom();
    }
    emit("change", messages.value, flag, currentContextMemory.value);
});

/** 自动或手动压缩完成后立即持久化摘要元数据，不必等到下一轮消息结束。 */
watch(currentContextMemory, (memory) => emit("change", messages.value, loading.value, memory));

watch(
    () => [props.visible, stickRef.value],
    () => {
        const root = stickRef.value?.$el as HTMLElement | undefined;
        if (!root) return;
        root.style.display = props.visible ? "block" : "none";
    },
    {
        immediate: true,
    },
);
let compressionMsg: AgentCompressionMessage | null = null;
watch(compressionState, (state) => {
    if (state.status === "running") {
        compressionMsg = {
            id: crypto.randomUUID(),
            role: "system",
            content: state.message,
            status: "running",
            notice: "compression",
        };
        messages.value.push(compressionMsg);
    }
    if (!compressionMsg) return;
    compressionMsg.status = state.status;
    compressionMsg.content = state.message;
});

/** 首包文本/推理/工具到达前显示 Loader，与 AI Elements Vue chatbot 示例一致。 */
const waitingForFirstToken = computed(() => {
    const last = messages.value.at(-1);
    if (!loading.value || last?.role !== "assistant") return false;
    const res = last as AgentResponseMessage;
    return !res.content && !res.reasoning && res.tools.length === 0 && res.statusLines.length === 0;
});

async function copyMessage(id: string, text: string) {
    copiedMessageId.value = id;
    await copyMessageText(text);
}

function applySuggestion(text: string) {
    if (!agent.value || loading.value) return;
    // 快捷问题直接交给 Agent.submit，不经过输入框，避免覆盖用户正在编辑的内容。
    void _submit({ content: text });
}

/** 聊天记录里点击缩略图后放大查看。 */
const imagePreview = ref<{ src: string; alt: string } | null>(null);

function openImagePreview(src: string, alt: string) {
    imagePreview.value = { src, alt };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 把压缩状态映射到固定图标，模板只负责展示，避免多层条件分支影响可读性。 */
function compressionIcon(status: AgentCompressionStatus): string {
    if (status === "running") return "mdi:loading";
    if (status === "compressed") return "mdi:check-circle-outline";
    if (status === "error") return "mdi:alert-circle-outline";
    return "mdi:information-outline";
}

/** 错误条自动消失定时器：避免提示一直浮在输入区上方遮挡操作。 */
let submitErrorTimer: ReturnType<typeof setTimeout> | undefined;

function dismissSubmitError() {
    clearTimeout(submitErrorTimer);
    submitErrorTimer = undefined;
    submitError.value = null;
}

function showSubmitError(error: unknown) {
    submitError.value = getErrorMessage(error);
    // 8 秒后自动关闭；期间用户也可以手动关掉。
    clearTimeout(submitErrorTimer);
    submitErrorTimer = setTimeout(dismissSubmitError, 8000);
}

function _submit(data: AgentPromptSubmitOptions) {
    // 发起新提交时先清掉上一条错误，避免旧报错误导用户。
    dismissSubmitError();
    void submit(data).catch(showSubmitError);
}

/**
 * 对话中切换模型后，在时间线末尾补一条居中的系统提示。
 * 空会话不插：新会话首次选模型就是初始模型，且空会话不落盘，避免历史列表被只有提示的会话占满。
 */
function appendModelSwitchNotice(model: string) {
    if (!messages.value.length) return;
    messages.value.push({
        id: crypto.randomUUID(),
        role: "system",
        content: "",
        notice: "model-switch",
        model,
    });
    // 提示是会话正文的一部分，立即落盘；running 状态沿用真实值，避免误改其它会话的运行标记。
    emit("change", messages.value, loading.value, currentContextMemory.value);
    stickRef.value?.scrollToBottom();
}

/**
 * 模型切换通知由 Agent 门面向上推送：任何入口（输入区菜单或程序式调用）切换都会在此补提示，
 * UI 不再依赖 PromptInput 向下转发。agent 实例异步创建，用 watch 挂订阅。
 */
let offModelSelect: (() => void) | undefined;
watch(agent, (instance) => {
    offModelSelect?.();
    offModelSelect = instance?.onModelSelect((next) => appendModelSwitchNotice(next.model));
});

onBeforeUnmount(() => {
    offModelSelect?.();
    clearTimeout(submitErrorTimer);
});

onMounted(async () => {
    await nextTick();
    setTimeout(() => {
        initial.value = "smooth";
    }, 1000);
});

defineExpose({
    agentProxy,
    loading,
    submit: _submit,
    stop,
    messages,
    appendModelSwitchNotice,
    compressContext: agentProxy.compressContext,
});
</script>

<template>
    <StickToBottom ref="stickRef" class="ai-conversation" role="log" aria-label="Agent 对话" initial>
        <template #overlay>
            <ConversationScrollButton />
            <!-- 提交失败提示条：浮在对话区底部，可手动关闭或 8 秒后自动消失。 -->
            <Transition name="agent-submit-error">
                <div v-if="submitError" class="agent-submit-error" role="alert">
                    <Icon icon="mdi:alert-circle-outline" />
                    <span class="agent-submit-error-text">{{ submitError }}</span>
                    <button type="button" class="agent-submit-error-close" title="关闭" aria-label="关闭" @click="dismissSubmitError">
                        <Icon icon="mdi:close" />
                    </button>
                </div>
            </Transition>
        </template>
        <div class="ai-conversation-content">
            <!-- 空状态内部负责常用问题的展示和维护，这里只接收选择结果并提交给 Agent。 -->
            <ConversationEmptyState v-if="!messages.length" :disabled="!agent || loading" @submit="applySuggestion" />

            <template v-for="message in messages" :key="message.id">
                <!-- 模型切换系统提示：居中一行小字，不用气泡；随会话落盘，重开历史仍能看到。 -->
                <p v-if="message.role === 'system' && (message as AgentNoticeMessage).notice === 'model-switch'" class="agent-model-notice">
                    模型已切换至 {{ (message as AgentNoticeMessage).model }}
                </p>
                <p
                    v-else-if="message.role === 'system' && (message as AgentCompressionMessage).notice === 'compression'"
                    class="agent-compression-notice"
                    :class="`is-${(message as AgentCompressionMessage).status}`"
                    role="status"
                    aria-live="polite"
                >
                    <!-- 压缩过程使用独立的状态图标，避免依赖横线装饰表达系统提示。 -->
                    <Icon
                        :icon="compressionIcon((message as AgentCompressionMessage).status)"
                        :class="{ 'app-loading-spin': (message as AgentCompressionMessage).status === 'running' }"
                    />
                    <span>{{ (message as AgentCompressionMessage).content }}</span>
                </p>
                <Message v-else :from="message.role">
                    <!-- 按时间线交错渲染思考段落和工具日志，而不是把全部工具堆在思考末尾。 -->
                    <Reasoning
                        v-if="message.role === 'assistant'"
                        :timeline="resolveAgentTimeline(message as AgentResponseMessage)"
                        :tools="(message as AgentResponseMessage).tools"
                        :streaming="(message as AgentResponseMessage).streaming"
                        :status="(message as AgentResponseMessage).statusLines.at(-1)"
                        :usage="(message as AgentResponseMessage).usageMetadata"
                    />
                    <MessageResponse v-if="message.role === 'assistant' && message.content" :content="message.content" />
                    <p v-else-if="message.role === 'user' && message.content" class="agent-user-text">
                        {{ message.content }}
                    </p>
                    <!-- 图片用 previewUrl 缩略图；没有预览（非图片或副本丢失）时只显示文件名。 -->
                    <div
                        v-if="message.role === 'user' && (message as AgentInputMessage).attachments?.length"
                        class="agent-user-attachments"
                    >
                        <template v-for="file in (message as AgentInputMessage).attachments" :key="file.path">
                            <button
                                v-if="file.previewUrl"
                                type="button"
                                class="agent-user-attachment-preview"
                                :title="`查看 ${file.name}`"
                                @click="openImagePreview(file.previewUrl, file.name)"
                            >
                                <img :src="file.previewUrl" :alt="file.name" />
                            </button>
                            <span v-else class="agent-user-file">{{ file.name }}</span>
                        </template>
                    </div>
                    <p v-if="(message as AgentResponseMessage).error" class="agent-message-error">
                        {{ (message as AgentResponseMessage).error }}
                    </p>
                    <div v-if="message.content && !(message as AgentResponseMessage).streaming" class="ai-message-actions">
                        <!-- 复制操作按钮：原 MessageAction.vue 内联而来，目前只有复制一个操作。 -->
                        <button
                            type="button"
                            class="ai-message-action"
                            :title="messageCopied && copiedMessageId === message.id ? '已复制' : '复制'"
                            :aria-label="messageCopied && copiedMessageId === message.id ? '已复制' : '复制'"
                            @click="copyMessage(message.id, message.content)"
                        >
                            <Icon :icon="messageCopied && copiedMessageId === message.id ? 'mdi:check' : 'mdi:content-copy'" />
                        </button>
                    </div>
                </Message>
            </template>
            <Loader v-if="waitingForFirstToken" />
        </div>
    </StickToBottom>
    <ImageLightbox :src="imagePreview?.src" :alt="imagePreview?.alt" @close="imagePreview = null" />
</template>

<style scoped lang="scss">
.ai-conversation {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: hidden;
}
.ai-conversation-content {
    display: flex;
    flex-direction: column;
    gap: 18px;
    width: min(100%, 920px);
    min-height: 100%;
    margin: 0 auto;
    padding: 24px 8px;
    box-sizing: border-box;
}

/* 消息操作按钮布局（原 MessageAction.vue 内联样式），颜色主题在 theme.*.scss 的 .ai-message-action 中。 */
.ai-message-action {
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    font-size: 15px;
}
.ai-message-actions {
    display: flex;
    align-items: center;
    gap: 2px;
}

.agent-user-text,
.agent-message-error {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
}
.agent-user-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
}
.agent-user-attachment-preview {
    display: block;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: zoom-in;
    img {
        display: block;
        max-width: 180px;
        max-height: 120px;
        object-fit: contain;
        border-radius: 8px;
    }
}
.agent-user-file {
    padding: 4px 8px;
    border-radius: 8px;
    font-size: var(--font-size-xs);
}
.agent-message-error {
    font-size: var(--font-size-sm);
}

/* 模型切换系统提示布局：居中一行小字；颜色主题在 theme.*.scss 的 .agent-model-notice 中。 */
.agent-model-notice {
    align-self: center;
    margin: 0;
    font-size: var(--font-size-xs);
    line-height: 1.5;
    text-align: center;
}

/* 压缩提示使用紧凑状态条；主题色、背景和边框统一由两个 theme 文件维护。 */
.agent-compression-notice {
    display: inline-flex;
    min-height: 26px;
    align-self: center;
    align-items: center;
    gap: 7px;
    box-sizing: border-box;
    margin: 0;
    padding: 4px 11px;
    border: 1px solid transparent;
    border-radius: 999px;
    font-size: var(--font-size-xs);
    line-height: 1.4;
    text-align: center;
    > svg {
        flex: none;
        font-size: 14px;
    }
}
/* 提交失败提示条布局：浮在对话区底部居中，颜色主题在 theme.*.scss 的 .agent-submit-error 中。 */
.agent-submit-error {
    position: absolute;
    bottom: 16px;
    left: 50%;
    z-index: 3;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    box-sizing: border-box;
    width: min(calc(100% - 32px), 640px);
    padding: 10px 12px;
    border-radius: 10px;
    transform: translateX(-50%);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    > svg {
        flex: none;
        margin-top: 2px;
        font-size: 16px;
    }
}
.agent-submit-error-text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
}
.agent-submit-error-close {
    display: inline-flex;
    flex: none;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    font-size: 14px;
}
/* 提示条进出场过渡：用 translate 属性做位移，避免和居中的 transform 冲突。 */
.agent-submit-error-enter-active,
.agent-submit-error-leave-active {
    transition:
        opacity 0.2s ease,
        translate 0.2s ease;
}
.agent-submit-error-enter-from,
.agent-submit-error-leave-to {
    opacity: 0;
    translate: 0 6px;
}
</style>
