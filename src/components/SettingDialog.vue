<script setup lang="ts">
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storeToRefs } from "pinia";
import { ensureModelConfigFile, loadModelConfigDraft, writeModelConfig } from "@/agent/config/loader";
import {
    DEFAULT_MODEL_CONFIG,
    DEFAULT_MODELS_CONFIG,
    MAX_CONTEXT_WINDOW_TOKENS,
    MIN_CONTEXT_WINDOW_TOKENS,
    ModelsConfigSchema,
    formatContextTokens,
    resolveActiveModelId,
    resolveMaxContextWindowTokens,
    type ModelProfile,
    type ModelsConfig,
} from "@/agent/config/schema";
import { DEFAULT_CONFIG_PATH } from "@/agent/paths";
import { initialState, type ServerRemoteData } from "@/stores/config";
import { invoke } from "@/utils/project";

defineOptions({ name: "SettingsDialog" });

export type SettingsTab = "general" | "appearance" | "layout" | "terminal" | "agent" | "server" | "about";

const configStore = useConfigStore();
const serverDataStore = useServerDataStore();
const { loadFalg } = storeToRefs(configStore);

const { uploadServerData, downloadServerData } = serverDataStore;

const activeTab = defineModel<SettingsTab>("activeTab", { required: true });

const draft = reactive<ConfigModel>({ ...initialState });

const terminalFonts = ref<LocalFont[]>([]);
const englishTermFont = ref("");
const chineseTermFont = ref("");
const defaultEnglishTermFont = ref("");
const defaultChineseTermFont = ref("");
const fontsLoading = ref(false);
const fontLoadError = ref("");
const version = ref("");

/** Agent 多模型配置独立存放在 model.json，不混入应用的 Pinia 配置。 */
const agentDraft = reactive<ModelsConfig>(cloneModelsConfig(DEFAULT_MODELS_CONFIG));
/** number 输入的空值代表不限制，按模型 id 分开保存草稿，切换模型时不会丢失输入。 */
const agentMaxTokens = reactive<Record<string, string>>({});
const agentConfigLoading = ref(true);
const agentConfigSaving = ref(false);
const agentConfigError = ref("");
const agentConfigReady = ref(false);
const agentApiKeyVisible = ref(false);
/** 仅用于设置页选择正在编辑的条目，不代表 Agent 运行时当前模型。 */
const selectedAgentModelId = ref(DEFAULT_MODELS_CONFIG.models[0].id);

const selectedAgentModel = computed<ModelProfile | undefined>(() =>
    agentDraft.models.find((model) => model.id === selectedAgentModelId.value),
);

/**
 * 同一条目改模型名时按对照表回填最大上下文。
 * 切换正在编辑的条目时不能写回，否则会覆盖另一条已经手填的上限。
 */
watch(
    () => [selectedAgentModelId.value, selectedAgentModel.value?.model] as const,
    ([modelId, modelName], [previousId, previousName]) => {
        const model = selectedAgentModel.value;
        if (!model || modelId !== previousId || !modelName || modelName === previousName) return;
        const maximumContext = resolveMaxContextWindowTokens(modelName);
        model.maxContextWindowTokens = maximumContext;
        model.contextWindowTokens = Math.min(Math.max(MIN_CONTEXT_WINDOW_TOKENS, model.contextWindowTokens), maximumContext);
    },
);

/** 降低模型最大上下文时，把当前会话预算同步压回合法范围。 */
function syncContextWindowToMaximum() {
    const model = selectedAgentModel.value;
    if (!model) return;
    model.contextWindowTokens = Math.min(
        Math.max(MIN_CONTEXT_WINDOW_TOKENS, Number(model.contextWindowTokens)),
        Number(model.maxContextWindowTokens),
    );
}

const serverSyncPath = ref("");
const serverSyncUrl = ref("");
const remoteSync = ref<ServerRemoteData>({
    ip: "",
    port: 22,
    user: "",
    password: "",
    path: "/home",
});

type LocalFont = {
    name: string;
    has_latin: boolean;
    has_cjk: boolean;
    is_monospace: boolean;
};

type LocalFontsPayload = {
    default_english_font: string;
    default_chinese_font: string;
    fonts: LocalFont[];
};

const englishFontOptions = computed(() => {
    const fonts = terminalFonts.value.filter((font) => font.has_latin && !font.has_cjk).sort(sortEnglishFonts);
    return ensureSelectedFont(fonts, englishTermFont.value, { has_latin: true, has_cjk: false });
});

const chineseFontOptions = computed(() => {
    const fonts = terminalFonts.value.filter((font) => font.has_cjk).sort(sortFontByName);
    return ensureSelectedFont(fonts, chineseTermFont.value, { has_latin: true, has_cjk: true });
});

const terminalPreviewStyle = computed(() => ({
    fontFamily: draft.termFontFamily || undefined,
    fontSize: `${draft.termFontSize}px`,
    lineHeight: String(draft.termLineHeight),
}));

function sortFontByName(a: LocalFont, b: LocalFont) {
    return a.name.localeCompare(b.name);
}

function sortEnglishFonts(a: LocalFont, b: LocalFont) {
    if (a.is_monospace !== b.is_monospace) return a.is_monospace ? -1 : 1;
    return sortFontByName(a, b);
}

function ensureSelectedFont(fonts: LocalFont[], selected: string, flags: Pick<LocalFont, "has_latin" | "has_cjk">) {
    const options = [...fonts];
    if (selected && !options.some((font) => font.name === selected)) {
        options.unshift({ name: selected, is_monospace: false, ...flags });
    }
    return options;
}

function syncTermFontSelectorsFromDraft() {
    const [english = "", chinese = ""] = draft.termFontFamily.split(",").map((font) => font.trim());
    englishTermFont.value = english || defaultEnglishTermFont.value;
    chineseTermFont.value = chinese || defaultChineseTermFont.value;
    updateDraftTermFontFamily();
}

function updateDraftTermFontFamily() {
    draft.termFontFamily = [englishTermFont.value, chineseTermFont.value].filter(Boolean).join(",");
}

watch(
    loadFalg,
    (newVal) => {
        if (!newVal) return;
        const config: ConfigModel = {
            theme: configStore.theme,
            themeMode: configStore.themeMode,
            fontSize: configStore.fontSize,
            downloadDir: configStore.downloadDir,
            compactMode: configStore.compactMode,
            overviewWidthPx: configStore.overviewWidthPx,
            sftpPanelHeightPx: configStore.sftpPanelHeightPx,
            sftpTreeWidthPx: configStore.sftpTreeWidthPx,
            agentPanelWidthPx: configStore.agentPanelWidthPx,
            termFontSize: configStore.termFontSize,
            termLineHeight: configStore.termLineHeight,
            termFontFamily: configStore.termFontFamily,
            termScrollback: configStore.termScrollback,
            serverSyncKey: configStore.serverSyncKey,
            serverSyncType: configStore.serverSyncType,
            serverSyncData: configStore.serverSyncData,
            autoServerSync: configStore.autoServerSync,
        };
        Object.assign(draft, config);
        serverSyncPath.value = draft.serverSyncType === "localFile" ? (draft.serverSyncData as string) : "";
        serverSyncUrl.value = draft.serverSyncType === "http" ? (draft.serverSyncData as string) : "";
        remoteSync.value = draft.serverSyncType === "remoteFile" ? (draft.serverSyncData as ServerRemoteData) : remoteSync.value;
        syncTermFontSelectorsFromDraft();
    },
    { immediate: true },
);

onMounted(async () => {
    activeTab.value = "general";
    loadLocalFonts();
    // 版本信息和 Agent 配置互不依赖，并行读取可缩短设置窗口的可用等待时间。
    const [appVersion] = await Promise.all([getVersion(), loadAgentConfig()]);
    version.value = appVersion;
});

const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: "常规" },
    { id: "appearance", label: "外观" },
    { id: "layout", label: "布局" },
    { id: "terminal", label: "终端" },
    { id: "agent", label: "Agent" },
    { id: "server", label: "服务器" },
    { id: "about", label: "关于" },
];

async function persistAndSync(): Promise<boolean> {
    if (!draft.downloadDir.trim()) {
        showToast("请填写本地下载保存路径", "error");
        return false;
    }
    if (!(await persistAgentConfig())) return false;
    configStore.changeConfig({
        ...draft,
        serverSyncData: getServerSyncData(),
    });
    return true;
}

async function onApply() {
    if (await persistAndSync()) {
        showToast("设置已保存", "success");
    }
}

async function onOk() {
    if (await persistAndSync()) {
        await getCurrentWindow().close();
    }
}

function onCancel() {
    void getCurrentWindow().close();
}

/** 从固定的 model.json 读取已校验配置，并同步到表单草稿。 */
async function loadAgentConfig() {
    agentConfigLoading.value = true;
    agentConfigError.value = "";
    agentConfigReady.value = false;
    try {
        await ensureModelConfigFile(DEFAULT_CONFIG_PATH);
        const config = await loadModelConfigDraft(DEFAULT_CONFIG_PATH);
        replaceAgentDraft(config);
        agentConfigReady.value = true;
    } catch (error) {
        console.error("load agent config error:", error);
        agentConfigError.value = `读取 Agent 配置失败：${getErrorMessage(error)}`;
    } finally {
        agentConfigLoading.value = false;
    }
}

/**
 * 校验并持久化 Agent 表单。
 * maxTokens 的空输入表示“不限制”，必须先转成 undefined 再交给 Zod，
 * 否则原生 number 输入会把空值作为字符串传入并导致错误配置落盘。
 */
async function persistAgentConfig(): Promise<boolean> {
    // 初次读取失败时表单里只有默认草稿，禁止把它误写回并覆盖用户原配置。
    if (!agentConfigReady.value) {
        const message = agentConfigError.value || "Agent 配置尚未读取完成";
        showToast(message, "error");
        return false;
    }
    agentConfigSaving.value = true;
    agentConfigError.value = "";
    try {
        const models = agentDraft.models.map((model) => {
            const maxTokensText = (agentMaxTokens[model.id] ?? "").trim();
            const maximumContext = Math.max(MIN_CONTEXT_WINDOW_TOKENS, Number(model.maxContextWindowTokens));
            return {
                ...model,
                maxTokens: maxTokensText ? Number(maxTokensText) : undefined,
                maxContextWindowTokens: maximumContext,
                // 降低模型最大上下文时同步收敛当前值，避免生成无法加载的配置。
                contextWindowTokens: Math.min(maximumContext, Math.max(MIN_CONTEXT_WINDOW_TOKENS, Number(model.contextWindowTokens))),
            };
        });
        const result = ModelsConfigSchema.safeParse({
            ...agentDraft,
            models,
            // 设置页编辑的是配置条目，不能把“正在编辑的模型”误当成输入区默认模型。
            activeModelId: resolveActiveModelId(models, agentDraft.activeModelId),
        });
        if (!result.success) {
            // 忽略Agent的配置错误。
            return true;
        }

        // 直接写入 model.json；已运行 Agent 的文件监听会完成热重载，无需在设置页创建模型实例。
        await writeModelConfig(DEFAULT_CONFIG_PATH, result.data);
        replaceAgentDraft(result.data);
        return true;
    } catch (error) {
        console.error("save agent config error:", error);
        agentConfigError.value = `保存 Agent 配置失败：${getErrorMessage(error)}`;
        showToast(agentConfigError.value, "error");
        return false;
    } finally {
        agentConfigSaving.value = false;
    }
}

/** 仅重置模型列表草稿；用户点击“应用”或“确定”后才写入磁盘。 */
function resetAgentDraft() {
    replaceAgentDraft(DEFAULT_MODELS_CONFIG);
    agentConfigError.value = "";
}

/** 深拷贝模型数组，避免设置页修改 reactive 草稿时污染默认常量或加载结果。 */
function cloneModelsConfig(config: ModelsConfig): ModelsConfig {
    return {
        models: config.models.map((model) => ({ ...model })),
        activeModelId: config.activeModelId,
    };
}

/** 整体替换草稿并为每个模型同步 maxTokens 文本态。 */
function replaceAgentDraft(config: ModelsConfig) {
    const next = cloneModelsConfig(config);
    agentDraft.models.splice(0, agentDraft.models.length, ...next.models);
    agentDraft.activeModelId = next.activeModelId;
    if (!next.models.some((model) => model.id === selectedAgentModelId.value)) {
        selectedAgentModelId.value = next.models[0].id;
    }
    for (const id of Object.keys(agentMaxTokens)) delete agentMaxTokens[id];
    for (const model of next.models) {
        agentMaxTokens[model.id] = model.maxTokens === undefined ? "" : String(model.maxTokens);
    }
    agentApiKeyVisible.value = false;
}

/** 新模型使用独立 id，允许同一模型名连接不同网关。 */
function addAgentModel() {
    const model: ModelProfile = { ...DEFAULT_MODEL_CONFIG, id: crypto.randomUUID() };
    agentDraft.models.push(model);
    selectedAgentModelId.value = model.id;
    agentMaxTokens[model.id] = model.maxTokens === undefined ? "" : String(model.maxTokens);
    agentApiKeyVisible.value = false;
    agentConfigError.value = "";
}

/** 删除当前正在编辑的配置，并选择相邻项；至少保留一个模型。 */
function removeAgentModel() {
    if (agentDraft.models.length <= 1) return;
    const index = agentDraft.models.findIndex((model) => model.id === selectedAgentModelId.value);
    if (index < 0) return;
    const [removed] = agentDraft.models.splice(index, 1);
    delete agentMaxTokens[removed.id];
    selectedAgentModelId.value = agentDraft.models[Math.min(index, agentDraft.models.length - 1)].id;
    agentApiKeyVisible.value = false;
    agentConfigError.value = "";
}

function formatAgentModelOption(model: ModelProfile): string {
    return `${model.model || "未命名模型"} · ${model.baseURL || "默认接口"}`;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getServerSyncData(): string | ServerRemoteData {
    if (draft.serverSyncType === "localFile") {
        return serverSyncPath.value;
    } else if (draft.serverSyncType === "http") {
        return serverSyncUrl.value;
    } else if (draft.serverSyncType === "remoteFile") {
        return remoteSync.value;
    }
    return "";
}

async function pickDownloadDir() {
    const base = draft.downloadDir.replace(/\/$/, "") || undefined;
    const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: base,
    });
    if (typeof selected === "string" && selected.length) {
        draft.downloadDir = selected;
    }
}

async function loadLocalFonts() {
    fontsLoading.value = true;
    fontLoadError.value = "";
    try {
        const res = await invoke<LocalFontsPayload>("local_fonts");
        terminalFonts.value = res.fonts;
        defaultEnglishTermFont.value = res.default_english_font;
        defaultChineseTermFont.value = res.default_chinese_font;
        syncTermFontSelectorsFromDraft();
    } catch (err) {
        console.error("load local fonts error:", err);
        fontLoadError.value = "读取本地字体失败";
    } finally {
        fontsLoading.value = false;
    }
}

function resetLayoutDraft() {
    const def = initialState;
    draft.overviewWidthPx = def.overviewWidthPx;
    draft.sftpPanelHeightPx = def.sftpPanelHeightPx;
    draft.sftpTreeWidthPx = def.sftpTreeWidthPx;
}

async function pickLocalSyncFile() {
    const current = serverSyncPath.value.replace(/\\/g, "/");
    const base = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : undefined;
    const selected = await open({
        title: "选择同步目录",
        directory: true,
        multiple: false,
        defaultPath: base,
    });
    if (typeof selected === "string" && selected.length) {
        serverSyncPath.value = selected;
    }
}

async function clickUploadServerData() {
    try {
        configStore.serverSyncKey = draft.serverSyncKey;
        configStore.serverSyncData = getServerSyncData();
        await uploadServerData(draft.serverSyncKey);
        showToast("上传成功", "success");
        configStore.changeConfig({
            serverSyncKey: configStore.serverSyncKey,
            serverSyncData: configStore.serverSyncData,
        });
    } catch (error) {
        if (typeof error === "string") {
            showToast(error, "error");
        } else {
            showToast("上传失败", "error");
        }
    }
}

async function clickDownloadServerData() {
    try {
        configStore.serverSyncKey = draft.serverSyncKey;
        configStore.serverSyncData = getServerSyncData();
        await downloadServerData(draft.serverSyncKey);
        showToast("下载成功", "success");
        configStore.changeConfig({
            serverSyncKey: configStore.serverSyncKey,
            serverSyncData: configStore.serverSyncData,
        });
    } catch (error) {
        if (typeof error === "string") {
            showToast(error, "error");
        } else {
            showToast("下载失败", "error");
        }
    }
}
</script>

<template>
    <div
        ref="rootDialog"
        tabindex="-1"
        class="setting-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setting-dialog-title"
        @keydown.esc="onCancel"
    >
        <div data-tauri-drag-region="" class="drag-region"></div>
        <div class="setting-dialog-body">
            <nav class="setting-dialog-tabs" aria-label="设置分类">
                <button
                    v-for="t in tabs"
                    :key="t.id"
                    type="button"
                    class="setting-dialog-tab"
                    :class="{ active: activeTab === t.id }"
                    @click="activeTab = t.id"
                >
                    {{ t.label }}
                </button>
            </nav>
            <div class="setting-dialog-panels">
                <section v-show="activeTab === 'general'" class="setting-panel">
                    <p class="setting-field">
                        <label class="setting-label" for="dl-dir">本地下载保存路径</label>
                    </p>
                    <div class="setting-row mb-4">
                        <SystemInput id="dl-dir" v-model="draft.downloadDir" type="text" class="setting-input grow" autocomplete="off" />
                        <button type="button" class="setting-btn secondary" @click="pickDownloadDir">选择文件夹</button>
                    </div>
                    <p class="setting-field">
                        <label class="setting-label" for="font-size">字体大小</label>
                        <input
                            id="font-size"
                            v-model.number="draft.fontSize"
                            type="number"
                            min="8"
                            max="32"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                </section>

                <section v-show="activeTab === 'appearance'" class="setting-panel">
                    <p class="setting-field">
                        <span class="setting-label">主题风格</span>
                        <span class="setting-inline">
                            <label><input v-model="draft.theme" type="radio" value="nt" /> 拟态</label>
                            <label><input v-model="draft.theme" type="radio" value="glass" /> 毛玻璃</label>
                        </span>
                    </p>
                    <p class="setting-field">
                        <span class="setting-label">明暗</span>
                        <span class="setting-inline">
                            <label><input v-model="draft.themeMode" type="radio" value="dark" /> 深色</label>
                            <label><input v-model="draft.themeMode" type="radio" value="light" /> 浅色</label>
                        </span>
                    </p>
                    <p class="setting-field">
                        <label class="setting-check">
                            <input v-model="draft.compactMode" type="checkbox" />
                            紧凑布局（减小全局间距）
                        </label>
                    </p>
                </section>

                <section v-show="activeTab === 'layout'" class="setting-panel">
                    <p class="setting-field">
                        <label class="setting-label" for="ov-w">概览默认宽度 (px)</label>
                        <input
                            id="ov-w"
                            v-model.number="draft.overviewWidthPx"
                            type="number"
                            min="200"
                            max="480"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="term-h">文件管理默认高度 (px)</label>
                        <input
                            id="term-h"
                            v-model.number="draft.sftpPanelHeightPx"
                            type="number"
                            min="120"
                            max="800"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="tree-w">目录树宽度 (px)</label>
                        <input
                            id="tree-w"
                            v-model.number="draft.sftpTreeWidthPx"
                            type="number"
                            min="120"
                            max="520"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                    <p class="setting-actions">
                        <button type="button" class="setting-btn secondary" @click="resetLayoutDraft">恢复默认布局</button>
                    </p>
                </section>

                <section v-show="activeTab === 'terminal'" class="setting-panel">
                    <p class="setting-field">
                        <label class="setting-label" for="term-fs">字体大小</label>
                        <input
                            id="term-fs"
                            v-model.number="draft.termFontSize"
                            type="number"
                            min="8"
                            max="32"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="term-lh">行高</label>
                        <input
                            id="term-lh"
                            v-model.number="draft.termLineHeight"
                            type="number"
                            min="1"
                            max="2"
                            step="0.05"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="term-sb">滚动缓冲行数</label>
                        <input
                            id="term-sb"
                            v-model.number="draft.termScrollback"
                            type="number"
                            min="500"
                            max="99000"
                            step="500"
                            class="setting-input setting-input-narrow"
                        />
                    </p>
                    <div class="setting-field">
                        <span class="setting-label">字体</span>
                        <div class="term-font-preview" :style="terminalPreviewStyle">
                            <div>0123456789 abcdefghABCDEFGH</div>
                            <div>终端中文字体预览</div>
                        </div>
                        <div class="term-font-pickers">
                            <label class="term-font-picker">
                                <span class="setting-label">英文字体</span>
                                <select
                                    v-model="englishTermFont"
                                    class="setting-select term-font-list"
                                    size="10"
                                    :disabled="fontsLoading && !englishFontOptions.length"
                                    @change="updateDraftTermFontFamily"
                                >
                                    <option v-if="fontsLoading && !englishFontOptions.length" value="">正在读取本地字体...</option>
                                    <option v-for="font in englishFontOptions" :key="font.name" :value="font.name">
                                        {{ font.name }}
                                    </option>
                                </select>
                            </label>
                            <label class="term-font-picker">
                                <span class="setting-label">中文字体</span>
                                <select
                                    v-model="chineseTermFont"
                                    class="setting-select term-font-list"
                                    size="10"
                                    :disabled="fontsLoading && !chineseFontOptions.length"
                                    @change="updateDraftTermFontFamily"
                                >
                                    <option v-if="fontsLoading && !chineseFontOptions.length" value="">正在读取本地字体...</option>
                                    <option v-for="font in chineseFontOptions" :key="font.name" :value="font.name">
                                        {{ font.name }}
                                    </option>
                                </select>
                            </label>
                        </div>
                        <span v-if="fontLoadError" class="setting-hint">{{ fontLoadError }}</span>
                    </div>
                </section>

                <!-- Agent 模型参数与 src/agent/config/schema.ts 保持一一对应。 -->
                <section v-show="activeTab === 'agent'" class="setting-panel setting-agent">
                    <p v-if="agentConfigLoading" class="setting-agent-status">正在读取 Agent 配置...</p>
                    <div v-else-if="agentConfigError && !agentConfigReady" class="setting-agent-status error" role="alert">
                        <span>{{ agentConfigError }}</span>
                        <button type="button" class="setting-btn secondary" @click="loadAgentConfig">重新读取</button>
                    </div>
                    <fieldset v-else class="setting-agent-form" :disabled="agentConfigSaving">
                        <p class="setting-field">
                            <label class="setting-label" for="agent-w">Agent面板宽度 (px)</label>
                            <input
                                id="agent-w"
                                v-model.number="draft.agentPanelWidthPx"
                                type="number"
                                min="200"
                                max="1000"
                                class="setting-input setting-input-narrow"
                            />
                        </p>
                        <div class="setting-agent-models">
                            <label class="setting-label" for="agent-edit-model">模型配置</label>
                            <div class="setting-row">
                                <select id="agent-edit-model" v-model="selectedAgentModelId" class="setting-select grow">
                                    <option v-for="model in agentDraft.models" :key="model.id" :value="model.id">
                                        {{ formatAgentModelOption(model) }}
                                    </option>
                                </select>
                                <button type="button" class="setting-btn secondary" @click="addAgentModel">新增模型</button>
                                <button
                                    type="button"
                                    class="setting-btn secondary"
                                    :disabled="agentDraft.models.length <= 1"
                                    @click="removeAgentModel"
                                >
                                    删除此配置
                                </button>
                            </div>
                            <span class="setting-hint">这里只维护可用模型配置，不会切换 Agent 当前使用的模型</span>
                        </div>
                        <template v-if="selectedAgentModel">
                            <p class="setting-field">
                                <label class="setting-label" for="agent-provider">接口类型</label>
                                <select id="agent-provider" v-model="selectedAgentModel.provider" class="setting-select setting-input-wide">
                                    <option value="openai-compatible">OpenAI Compatible</option>
                                </select>
                                <span class="setting-hint">支持 DeepSeek、通义、Ollama 等 OpenAI 兼容接口</span>
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="agent-model">模型名称</label>
                                <SystemInput
                                    id="agent-model"
                                    v-model="selectedAgentModel.model"
                                    type="text"
                                    class="setting-input setting-input-wide"
                                    autocomplete="off"
                                    placeholder="deepseek-v4-flash"
                                />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="agent-base-url">接口地址</label>
                                <SystemInput
                                    id="agent-base-url"
                                    v-model="selectedAgentModel.baseURL"
                                    type="url"
                                    class="setting-input setting-input-wide"
                                    autocomplete="off"
                                    placeholder="https://api.deepseek.com"
                                />
                                <span class="setting-hint">DeepSeek 官方接口可使用默认地址</span>
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="agent-api-key">API Key</label>
                                <span class="setting-agent-secret">
                                    <SystemInput
                                        id="agent-api-key"
                                        v-model="selectedAgentModel.apiKey"
                                        :type="agentApiKeyVisible ? 'text' : 'password'"
                                        class="setting-input grow"
                                        autocomplete="off"
                                        placeholder="请输入 API Key"
                                        required
                                    />
                                    <button type="button" class="setting-btn secondary" @click="agentApiKeyVisible = !agentApiKeyVisible">
                                        {{ agentApiKeyVisible ? "隐藏" : "显示" }}
                                    </button>
                                </span>
                                <span class="setting-hint">必填；API Key 将保存到本机 model.json 配置文件</span>
                            </p>
                            <div class="setting-agent-grid">
                                <p class="setting-field">
                                    <label class="setting-label" for="agent-temperature">Temperature</label>
                                    <input
                                        id="agent-temperature"
                                        v-model.number="selectedAgentModel.temperature"
                                        type="number"
                                        min="0"
                                        max="2"
                                        step="0.1"
                                        class="setting-input"
                                    />
                                    <span class="setting-hint">范围 0–2</span>
                                </p>
                                <p class="setting-field">
                                    <label class="setting-label" for="agent-max-tokens">最大 Token 数</label>
                                    <input
                                        id="agent-max-tokens"
                                        v-model="agentMaxTokens[selectedAgentModel.id]"
                                        type="number"
                                        min="1"
                                        step="1"
                                        class="setting-input"
                                        placeholder="不限制"
                                    />
                                    <span class="setting-hint">留空表示使用服务端默认值</span>
                                </p>
                                <p class="setting-field setting-context-slider">
                                    <label class="setting-label" for="agent-max-context-tokens">
                                        模型最大上下文
                                        <strong>{{ formatContextTokens(selectedAgentModel.maxContextWindowTokens) }}</strong>
                                    </label>
                                    <input
                                        id="agent-max-context-tokens"
                                        v-model.number="selectedAgentModel.maxContextWindowTokens"
                                        type="range"
                                        :min="MIN_CONTEXT_WINDOW_TOKENS"
                                        :max="MAX_CONTEXT_WINDOW_TOKENS"
                                        step="1000"
                                        aria-label="模型最大上下文"
                                        @input="syncContextWindowToMaximum"
                                    />
                                    <span class="setting-context-slider-limits">
                                        <span>{{ formatContextTokens(MIN_CONTEXT_WINDOW_TOKENS) }}</span>
                                        <span>{{ formatContextTokens(MAX_CONTEXT_WINDOW_TOKENS) }}</span>
                                    </span>
                                    <span class="setting-hint"
                                        >已知模型会按名称自动填充；输入区滑动条范围：{{
                                            formatContextTokens(MIN_CONTEXT_WINDOW_TOKENS)
                                        }}
                                        至此上限</span
                                    >
                                </p>
                                <p class="setting-field">
                                    <label class="setting-label" for="agent-timeout">超时时间（毫秒）</label>
                                    <input
                                        id="agent-timeout"
                                        v-model.number="selectedAgentModel.timeout"
                                        type="number"
                                        min="1"
                                        step="1000"
                                        class="setting-input"
                                    />
                                </p>
                                <p class="setting-field">
                                    <label class="setting-label" for="agent-retries">最大重试次数</label>
                                    <input
                                        id="agent-retries"
                                        v-model.number="selectedAgentModel.maxRetries"
                                        type="number"
                                        min="0"
                                        step="1"
                                        class="setting-input"
                                    />
                                </p>
                            </div>
                        </template>
                        <p v-if="agentConfigError" class="setting-agent-status error" role="alert">{{ agentConfigError }}</p>
                        <div class="setting-agent-meta">
                            <span class="setting-hint setting-agent-path">配置文件：{{ DEFAULT_CONFIG_PATH }}</span>
                            <button type="button" class="setting-btn secondary" @click="resetAgentDraft">恢复默认 Agent 配置</button>
                        </div>
                    </fieldset>
                </section>

                <section v-show="activeTab === 'server'" class="setting-panel setting-server">
                    <p class="setting-field">
                        <label class="setting-label" for="server-sync-key">同步 key</label>
                        <SystemInput
                            id="server-sync-key"
                            v-model="draft.serverSyncKey"
                            type="text"
                            class="setting-input setting-input-narrow"
                            autocomplete="off"
                        />
                    </p>
                    <p class="setting-field">
                        <span class="setting-label">同步类型</span>
                        <span class="setting-inline">
                            <label><input v-model="draft.serverSyncType" type="radio" value="localFile" /> 本地文件</label>
                            <label><input v-model="draft.serverSyncType" type="radio" value="http" /> HTTP</label>
                            <label><input v-model="draft.serverSyncType" type="radio" value="remoteFile" /> 远程文件</label>
                        </span>
                    </p>

                    <div v-if="draft.serverSyncType === 'localFile'" class="setting-sync-panel">
                        <p class="setting-field">
                            <label class="setting-label" for="server-sync-path">本地目录</label>
                        </p>
                        <div class="setting-row">
                            <input
                                id="server-sync-path"
                                v-model="serverSyncPath"
                                type="text"
                                class="setting-input grow"
                                autocomplete="off"
                                placeholder="选择或输入同步文件路径"
                            />
                            <button type="button" class="setting-btn secondary" @click="pickLocalSyncFile">选择文件</button>
                        </div>
                    </div>

                    <div v-else-if="draft.serverSyncType === 'http'" class="setting-sync-panel">
                        <p class="setting-field">
                            <label class="setting-label" for="server-sync-url">URL 地址</label>
                            <input
                                id="server-sync-url"
                                v-model="serverSyncUrl"
                                type="url"
                                class="setting-input setting-input-wide"
                                autocomplete="off"
                                placeholder="https://example.com/sync"
                            />
                            <span class="setting-hint">下载使用 GET 请求，上传使用 POST 请求</span>
                        </p>
                    </div>

                    <div v-else-if="draft.serverSyncType === 'remoteFile'" class="setting-sync-panel">
                        <div class="setting-sync-remote-grid">
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-ip">主机 IP</label>
                                <SystemInput
                                    id="server-sync-ip"
                                    v-model="remoteSync.ip"
                                    type="text"
                                    class="setting-input setting-input-wide"
                                    autocomplete="off"
                                    placeholder="192.168.1.1"
                                />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-port">端口</label>
                                <input
                                    id="server-sync-port"
                                    v-model.number="remoteSync.port"
                                    type="number"
                                    min="1"
                                    max="65535"
                                    class="setting-input setting-input-narrow"
                                />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-user">用户名</label>
                                <SystemInput
                                    id="server-sync-user"
                                    v-model="remoteSync.user"
                                    type="text"
                                    class="setting-input setting-input-wide"
                                    autocomplete="username"
                                />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-password">密码</label>
                                <input
                                    id="server-sync-password"
                                    v-model="remoteSync.password"
                                    type="password"
                                    class="setting-input setting-input-wide"
                                    autocomplete="current-password"
                                />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-path">远程目录</label>
                                <SystemInput
                                    id="server-sync-path"
                                    v-model="remoteSync.path"
                                    type="text"
                                    class="setting-input setting-input-wide"
                                    autocomplete="off"
                                    placeholder="/home"
                                />
                            </p>
                        </div>
                    </div>

                    <p class="setting-field">
                        <label class="setting-check">
                            <input v-model="draft.autoServerSync" type="checkbox" />
                            自动服务器同步(自动上传、自动下载)
                        </label>
                    </p>
                    <div class="setting-server-actions mt-4">
                        <button type="button" class="setting-btn upload-btn" @click="clickUploadServerData">
                            <Icon icon="lucide:upload" />
                            上传
                        </button>
                        <button type="button" class="setting-btn download-btn" @click="clickDownloadServerData">
                            <Icon icon="lucide:download" />
                            下载
                        </button>
                    </div>
                </section>

                <section v-show="activeTab === 'about'" class="setting-panel setting-about">
                    <p class="setting-about-name">Keray Shell</p>
                    <p class="setting-about-line">本地 SSH / SFTP 客户端</p>
                    <p class="setting-about-line muted">版本：{{ version }}</p>
                </section>
            </div>
        </div>
        <footer class="setting-dialog-footer">
            <button type="button" class="setting-btn secondary" @click="onCancel">取消</button>
            <button type="button" class="setting-btn" :disabled="agentConfigLoading || agentConfigSaving" @click="onApply">应用</button>
            <button type="button" class="setting-btn primary" :disabled="agentConfigLoading || agentConfigSaving" @click="onOk">
                确定
            </button>
        </footer>
    </div>
</template>

<style scoped lang="scss">
.setting-dialog {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    border-radius: 10px;
    width: 100%;
    height: 100%;
    max-height: none;
}

.setting-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    flex-shrink: 0;
}

.setting-dialog-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 600;
}

.setting-dialog-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid transparent;
    cursor: pointer;
}

.setting-dialog-body {
    display: flex;
    min-height: 0;
    flex: 1;
    overflow: hidden;
}

.setting-dialog-tabs {
    padding-top: 30px;
    flex-shrink: 0;
    width: 112px;
    padding: 30px 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.setting-dialog-tab {
    text-align: left;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: var(--font-size-md);
    cursor: pointer;
}

.setting-dialog-panels {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    overflow: auto;
}

.setting-panel {
    font-size: var(--font-size-md);
}

.setting-field {
    margin: 0 0 12px;
}

.setting-label {
    display: block;
    margin-bottom: 4px;
    font-weight: 600;
}

.setting-hint {
    display: block;
    margin-top: 2px;
    font-size: var(--font-size-xs);
    font-weight: 400;
}

.setting-inline {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    margin-top: 4px;

    label {
        cursor: pointer;
    }
}

.setting-check {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.setting-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.setting-input,
.setting-select {
    border-radius: 8px;
    padding: 8px 10px;
    font-size: var(--font-size-md);
    outline: none;
    min-width: 0;
}

.setting-input-narrow {
    width: 120px;
    max-width: 100%;
}

.setting-select {
    cursor: pointer;
    appearance: auto;
}

.term-font-preview {
    margin-bottom: 12px;
    padding: 10px;
    text-align: center;
    border-radius: 8px;
}

.term-font-pickers {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px;
}

.term-font-picker {
    display: block;
    min-width: 0;
}

.term-font-list {
    width: 100%;
    min-height: 180px;
    padding: 4px;
}

.setting-dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px;
    flex-shrink: 0;
}

.setting-btn {
    padding: 7px 14px;
    border-radius: 8px;
    font-size: var(--font-size-md);
    cursor: pointer;
}

.setting-actions {
    margin-top: 8px;
}

/* Agent 设置表单仅负责布局；颜色、边框等主题样式统一放到两个主题文件。 */
.setting-agent-form {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
}

.setting-agent-models {
    margin-bottom: 14px;
    padding: 10px 12px;
    border: 1px solid;
    border-radius: 8px;

    .setting-select {
        min-width: 200px;
    }
}

.setting-agent-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 12px;

    .setting-input {
        width: 100%;
        box-sizing: border-box;
    }
}

/* 最大上下文需要完整宽度，避免挤在两列数字框里拖不动。 */
.setting-context-slider {
    grid-column: 1 / -1;

    .setting-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }

    input[type="range"] {
        width: 100%;
        margin: 6px 0 0;
        cursor: pointer;
    }
}

.setting-context-slider-limits {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 2px;
    font-size: var(--font-size-xs);
}

.setting-agent-secret {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 520px;
}

.setting-agent-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 12px;
    padding: 10px 12px;
    border: 1px solid;
    border-radius: 8px;
}

.setting-agent-meta {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    margin-top: 4px;
}

.setting-agent-path {
    min-width: 0;
    overflow-wrap: anywhere;
}

.setting-agent-form:disabled,
.setting-btn:disabled {
    cursor: wait;
    opacity: 0.65;
}

.setting-about {
    padding: 8px 0;
}

.setting-about-name {
    margin: 0 0 6px;
    font-size: var(--font-size-2xl);
    font-weight: 600;
}

.setting-about-line {
    margin: 0 0 6px;

    &.muted {
    }
}

@layer layout {
    .setting-input-wide {
        width: 100%;
        max-width: 420px;
        box-sizing: border-box;
    }

    .setting-sync-panel {
        margin-bottom: 14px;
        padding: 10px 12px;
        border-radius: 8px;
        border-width: 1px;
        border-style: solid;
    }

    .setting-sync-remote-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        column-gap: 12px;

        .setting-field:nth-child(3),
        .setting-field:nth-child(4) {
            grid-column: 1 / -1;
        }
    }
}

@layer components {
    .setting-server-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 4px;

        .setting-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            min-width: 108px;
            padding-inline: 16px;
        }
    }
}

@media (max-width: 620px) {
    .setting-agent-grid {
        grid-template-columns: 1fr;
    }

    .setting-agent-meta {
        align-items: stretch;
        flex-direction: column;
    }
}
</style>
