<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storeToRefs } from "pinia";
import { initialState, type ServerRemoteData } from "@/stores/config";
import { invoke } from "@/utils/project";

defineOptions({ name: "SettingsDialog" });

export type SettingsTab = "general" | "appearance" | "layout" | "terminal" | "server" | "about";

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

onMounted(() => {
    activeTab.value = "general";
    loadLocalFonts();
});

const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: "常规" },
    { id: "appearance", label: "外观" },
    { id: "layout", label: "布局" },
    { id: "terminal", label: "终端" },
    { id: "server", label: "服务器" },
    { id: "about", label: "关于" },
];

async function persistAndSync(): Promise<boolean> {
    if (!draft.downloadDir.trim()) {
        showToast("请填写本地下载保存路径", "error");
        return false;
    }
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

/** 模板里不能写 import.meta，需在 script 中取出 */
const buildMode = import.meta.env.MODE;

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
    <div ref="rootDialog" tabindex="-1" class="setting-dialog" role="dialog" aria-modal="true" aria-labelledby="setting-dialog-title" @keydown.esc="onCancel">
        <div data-tauri-drag-region="" class="drag-region"></div>
        <div class="setting-dialog-body">
            <nav class="setting-dialog-tabs" aria-label="设置分类">
                <button v-for="t in tabs" :key="t.id" type="button" class="setting-dialog-tab" :class="{ active: activeTab === t.id }" @click="activeTab = t.id">
                    {{ t.label }}
                </button>
            </nav>
            <div class="setting-dialog-panels">
                <section v-show="activeTab === 'general'" class="setting-panel">
                    <p class="setting-field">
                        <label class="setting-label" for="dl-dir">本地下载保存路径</label>
                    </p>
                    <div class="setting-row mb-4">
                        <input id="dl-dir" v-model="draft.downloadDir" type="text" class="setting-input grow" autocomplete="off" />
                        <button type="button" class="setting-btn secondary" @click="pickDownloadDir">选择文件夹</button>
                    </div>
                    <p class="setting-field">
                        <label class="setting-label" for="font-size">字体大小</label>
                        <input id="font-size" v-model.number="draft.fontSize" type="number" min="8" max="32" class="setting-input setting-input-narrow" />
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
                        <input id="ov-w" v-model.number="draft.overviewWidthPx" type="number" min="200" max="480" class="setting-input setting-input-narrow" />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="term-h">文件管理默认高度 (px)</label>
                        <input id="term-h" v-model.number="draft.sftpPanelHeightPx" type="number" min="120" max="800" class="setting-input setting-input-narrow" />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="tree-w">目录树宽度 (px)</label>
                        <input id="tree-w" v-model.number="draft.sftpTreeWidthPx" type="number" min="120" max="520" class="setting-input setting-input-narrow" />
                    </p>
                    <p class="setting-actions">
                        <button type="button" class="setting-btn secondary" @click="resetLayoutDraft">恢复默认布局</button>
                    </p>
                </section>

                <section v-show="activeTab === 'terminal'" class="setting-panel">
                    <p class="setting-field">
                        <label class="setting-label" for="term-fs">字体大小</label>
                        <input id="term-fs" v-model.number="draft.termFontSize" type="number" min="8" max="32" class="setting-input setting-input-narrow" />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="term-lh">行高</label>
                        <input id="term-lh" v-model.number="draft.termLineHeight" type="number" min="1" max="2" step="0.05" class="setting-input setting-input-narrow" />
                    </p>
                    <p class="setting-field">
                        <label class="setting-label" for="term-sb">滚动缓冲行数</label>
                        <input id="term-sb" v-model.number="draft.termScrollback" type="number" min="500" max="99000" step="500" class="setting-input setting-input-narrow" />
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

                <section v-show="activeTab === 'server'" class="setting-panel setting-server">
                    <p class="setting-field">
                        <label class="setting-label" for="server-sync-key">同步 key</label>
                        <input id="server-sync-key" v-model="draft.serverSyncKey" type="text" class="setting-input setting-input-narrow" autocomplete="off" />
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
                            <input id="server-sync-path" v-model="serverSyncPath" type="text" class="setting-input grow" autocomplete="off" placeholder="选择或输入同步文件路径" />
                            <button type="button" class="setting-btn secondary" @click="pickLocalSyncFile">选择文件</button>
                        </div>
                    </div>

                    <div v-else-if="draft.serverSyncType === 'http'" class="setting-sync-panel">
                        <p class="setting-field">
                            <label class="setting-label" for="server-sync-url">URL 地址</label>
                            <input id="server-sync-url" v-model="serverSyncUrl" type="url" class="setting-input setting-input-wide" autocomplete="off" placeholder="https://example.com/sync" />
                            <span class="setting-hint">下载使用 GET 请求，上传使用 POST 请求</span>
                        </p>
                    </div>

                    <div v-else-if="draft.serverSyncType === 'remoteFile'" class="setting-sync-panel">
                        <div class="setting-sync-remote-grid">
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-ip">主机 IP</label>
                                <input id="server-sync-ip" v-model="remoteSync.ip" type="text" class="setting-input setting-input-wide" autocomplete="off" placeholder="192.168.1.1" />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-port">端口</label>
                                <input id="server-sync-port" v-model.number="remoteSync.port" type="number" min="1" max="65535" class="setting-input setting-input-narrow" />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-user">用户名</label>
                                <input id="server-sync-user" v-model="remoteSync.user" type="text" class="setting-input setting-input-wide" autocomplete="username" />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-password">密码</label>
                                <input id="server-sync-password" v-model="remoteSync.password" type="password" class="setting-input setting-input-wide" autocomplete="current-password" />
                            </p>
                            <p class="setting-field">
                                <label class="setting-label" for="server-sync-path">远程目录</label>
                                <input id="server-sync-path" v-model="remoteSync.path" type="text" class="setting-input setting-input-wide" autocomplete="off" placeholder="/home" />
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
                    <p class="setting-about-line muted">构建模式：{{ buildMode }}</p>
                </section>
            </div>
        </div>
        <footer class="setting-dialog-footer">
            <button type="button" class="setting-btn secondary" @click="onCancel">取消</button>
            <button type="button" class="setting-btn" @click="onApply">应用</button>
            <button type="button" class="setting-btn primary" @click="onOk">确定</button>
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
</style>
