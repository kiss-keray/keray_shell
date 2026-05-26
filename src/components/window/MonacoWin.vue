<script setup lang="ts">
import { emitTo, TauriEvent } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import MonacoEditor, { type MonacoEditorModelSpec } from "@/components/monaco/MonacoEditor.vue";
import MonacoEditorTabs, { type MonacoTabItem } from "@/components/monaco/MonacoEditorTabs.vue";
import { languageFromPath } from "@/components/monaco/monacoEnv";
import type { ServerDataModel } from "@/stores/serverData";
const win = getCurrentWindow();

/** 编辑器内单个文件的状态 */
export type MonacoEditorFile = {
    /** 唯一键：sessionId + path */
    key: string;
    /** 当前编辑区内容 */
    content: string;
    /** 上次成功保存的内容，用于 dirty 判断 */
    savedContent: string;
    /** 推断的 Monaco 语言 ID */
    language: string;
    /** 远端下载进度 0–100 */
    downloadProcess: number;
    /** 远端上传进度 0–100 */
    uploadProcess: number;
    /** 是否仍在下载 */
    loading: boolean;
    /** 是否正在保存 */
    saving: boolean;
    /** 是否有未保存修改 */
    dirty: boolean;
    /** editor 层叠顺序，激活时递增 */
    zIndex: number;
    /** 服务器数据 */
    server: ServerDataModel | null;
} & MonacoEditorWindowPayload;

const appStore = useAppStore();
const serverStore = useServerDataStore();
const localStore = useLocalStore();
const { windowInitData, loadingText } = toRefs(appStore) as { windowInitData: Ref<MonacoEditorWindowPayload | MonacoEditorWindowPayload[] | null>; loadingText: Ref<string> };
const { findServerDataById, initTask } = serverStore;
const { tempRootDir } = localStore;
loadingText.value = "正在打开...";

/** 已打开文件列表 */
const editFiles = ref<MonacoEditorFile[]>([]);
/** 当前激活 tab 的 key */
const activeKey = ref("");
/** 激活 editor 层级计数器 */
const activeEditorZIndex = ref(0);
/** Monaco 子组件引用，保存时从对应 editor 读取最新文本 */
const editorRefs = new Map<string, InstanceType<typeof MonacoEditor>>();

/** 生成文件唯一 key */
function fileKey(payload: Pick<MonacoEditorWindowPayload, "sessionId" | "path">) {
    return `${payload.sessionId}::${payload.path}`;
}

/** Tab 栏展示数据 */
const tabItems = computed<MonacoTabItem[]>(() =>
    editFiles.value.map((f) => ({
        key: f.key,
        title: baseName(f.path),
        dirty: f.dirty,
        loading: f.loading,
        saving: f.saving,
    })),
);

function toEditorModel(file: MonacoEditorFile): MonacoEditorModelSpec {
    return {
        key: file.key,
        path: file.path,
        content: file.content,
        language: file.language,
        readOnly: file.loading || file.saving,
    };
}

function editorLayerStyle(file: MonacoEditorFile) {
    return {
        zIndex: file.zIndex,
        opacity: file.key === activeKey.value ? 1 : 0,
        pointerEvents: file.key === activeKey.value ? "auto" : "none",
    };
}

function setEditorRef(key: string, editor: unknown) {
    if (editor) {
        editorRefs.set(key, editor as InstanceType<typeof MonacoEditor>);
    } else {
        editorRefs.delete(key);
    }
}

function setActiveKey(key: string) {
    const file = editFiles.value.find((f) => f.key === key);
    if (!file) return;
    activeKey.value = key;
    file.zIndex = ++activeEditorZIndex.value;
}

function getEditorContent(key: string) {
    return editorRefs.get(key)?.getContent() ?? editFiles.value.find((f) => f.key === key)?.content ?? "";
}

const activeFile = computed(() => editFiles.value.find((f) => f.key === activeKey.value) ?? null);

/** 规范化 init / add 事件的 payload（支持单条或数组） */
function normalizePayloads(payload: MonacoEditorWindowPayload | MonacoEditorWindowPayload[]): MonacoEditorWindowPayload[] {
    return Array.isArray(payload) ? payload : [payload];
}

/** 追加打开文件；已存在则聚焦 */
async function openPayloads(payloads: MonacoEditorWindowPayload[]) {
    for (const payload of payloads) {
        const key = fileKey(payload);
        const existing = editFiles.value.find((f) => f.key === key);
        if (existing) {
            setActiveKey(key);
            continue;
        }
        const file = await payloadToFile(payload);
        if (file) {
            editFiles.value.push(file);
            setActiveKey(key);
        }
    }
}

/** 从窗口 payload 下载远端文件并创建编辑项 */
async function payloadToFile(payload: MonacoEditorWindowPayload): Promise<MonacoEditorFile | null> {
    const key = fileKey(payload);
    const file: MonacoEditorFile = {
        key,
        content: "数据加载中...0%",
        savedContent: "",
        language: languageFromPath(payload.path),
        downloadProcess: 0,
        uploadProcess: 0,
        loading: true,
        saving: false,
        dirty: false,
        zIndex: 0,
        server: null,
        ...payload,
    };
    setTimeout(async () => {
        await initTask;
        const server = findServerDataById(payload.serverId);
        file.server = server;
        const remotePath = payload.linkPath || payload.path;
        const item = await oneFileRemoteItem(payload.serverId, remotePath);
        loadingText.value = "";
        if (!server || !item) return null;
        let received = 0;
        const total = item.size || 0;
        try {
            let content = "";
            await sftpReadFileStream(server.id, remotePath, 0, (chunk) => {
                content += new TextDecoder().decode(chunk);
                received += chunk.length;
                file.downloadProcess = total > 0 ? (received / total) * 100 : 100;
                file.content = `数据加载中...${file.downloadProcess.toFixed(2)}%`;
                editFiles.value = [...editFiles.value];
            });
            file.content = content;
            file.savedContent = file.content;
            editFiles.value = [...editFiles.value];
        } catch (e) {
            console.error("下载文件失败", e);
            file.content = `# 下载失败: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
            file.loading = false;
            file.downloadProcess = 100;
        }
        editFiles.value = [...editFiles.value];
    });

    return file;
}

/** 保存指定文件到远端（Ctrl+S 调用） */
async function fileSave(key: string) {
    const file = editFiles.value.find((f) => f.key === key);
    if (!file || file.loading || file.saving) return;

    const server = findServerDataById(file.serverId);
    if (!server) return;

    // 从 Monaco model 读取最新内容，避免 reactive 对象与编辑器不同步
    const content = getEditorContent(key);
    file.content = content;
    file.saving = true;
    file.uploadProcess = 0;

    let tempPath = "";
    try {
        tempPath = await join(await tempRootDir, `${uuid()}_${baseName(file.path)}`);
        await writeTextFile(tempPath, content, { create: true });
        await writeLocalFileToRemote(server.id, file.path, tempPath, (process) => {
            file.uploadProcess = process;
        });
        file.savedContent = content;
        file.dirty = false;
        emitTo({ kind: "Window", label: file.from }, MONACO_EDITOR_SAVED_EVENT, {
            sessionId: file.sessionId,
            path: file.path,
        });
    } catch (e) {
        console.error("保存文件失败", e);
    } finally {
        file.saving = false;
        file.uploadProcess = 0;
        if (tempPath) await removeLocalIfAny(tempPath);
    }
}

function onEditorChange(key: string, content: string) {
    const file = editFiles.value.find((f) => f.key === key);
    if (!file || file.loading) return;
    file.content = content;
    file.dirty = content !== file.savedContent;
}

function onEditorSave(key: string) {
    fileSave(key);
}

function onTabSelect(key: string) {
    setActiveKey(key);
    nextTick(() => editorRefs.get(key)?.focus());
}

/** 从列表移除 tab 并清理 Monaco editor */
function removeTabAt(idx: number) {
    const file = editFiles.value[idx];
    if (!file) return;

    editorRefs.delete(file.key);
    editFiles.value.splice(idx, 1);

    if (activeKey.value === file.key) {
        const next = editFiles.value[Math.min(idx, editFiles.value.length - 1)];
        if (next) {
            setActiveKey(next.key);
        } else {
            activeKey.value = "";
        }
    }
    if (editFiles.value.length === 0) {
        getCurrentWindow().destroy();
    }
}

/** 关闭 tab：未保存时弹确认，保存中不可关 */
async function onTabClose(key: string) {
    const idx = editFiles.value.findIndex((f) => f.key === key);
    if (idx < 0) return;

    const file = editFiles.value[idx]!;

    // 保存进行中不允许关闭
    if (file.saving) return;

    // 关闭前同步编辑器最新内容，确保 dirty 判断准确
    const latest = getEditorContent(key);
    file.content = latest;
    file.dirty = latest !== file.savedContent;

    if (file.dirty) {
        const ok = await showConfirm({
            title: "关闭文件",
            message: `"${baseName(file.path)}" 有未保存的修改，确定关闭吗？`,
            danger: true,
        });
        if (!ok) return;
    }

    removeTabAt(idx);
}

// 窗口初次打开时的文件列表
watch(
    windowInitData,
    (payload) => {
        if (!payload) return;
        openPayloads(normalizePayloads(payload));
    },
    { immediate: true },
);

// 已有编辑窗口时追加文件
win.listen<MonacoEditorWindowPayload | MonacoEditorWindowPayload[]>(MONACO_EDITOR_ADD_ITEM, async ({ payload }) => {
    openPayloads(normalizePayloads(payload));
});
win.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
    if (editFiles.value.some((f) => f.dirty)) {
        const ok = await showConfirm({
            title: "确定关闭",
            message: "有未保存的修改，确定关闭吗？",
            danger: true,
        });
        if (ok) {
            win.destroy();
        }
    } else {
        win.destroy();
    }
});
</script>

<template>
    <GlobalButton :bts="['setting', 'theme', 'themeMode']" />
    <div class="monaco-editor-win">
        <MonacoEditorTabs :tabs="tabItems" :active-key="activeKey" @select="onTabSelect" @close="onTabClose" />
        <div class="monaco-body">
            <MonacoEditor
                v-for="file in editFiles"
                :key="file.key"
                :ref="(editor) => setEditorRef(file.key, editor)"
                class="monaco-editor-layer"
                :style="editorLayerStyle(file)"
                :file="toEditorModel(file)"
                @change="(content) => onEditorChange(file.key, content)"
                @save="onEditorSave(file.key)"
            />
        </div>
        <div v-if="activeFile" class="monaco-status">
            <span class="monaco-status-path" :title="activeFile.path">{{ activeFile.server?.name }}:{{ activeFile.path }}</span>
            <span v-if="activeFile.loading" class="monaco-status-hint">下载中 {{ Math.round(activeFile.downloadProcess) }}%</span>
            <span v-else-if="activeFile.saving" class="monaco-status-hint">保存中 {{ Math.round(activeFile.uploadProcess) }}%</span>
            <span v-else-if="activeFile.dirty" class="monaco-status-hint">未保存</span>
            <span v-else class="monaco-status-hint">已保存</span>
        </div>
    </div>
</template>

<style scoped lang="scss">
.monaco-editor-win {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100vh;
    min-height: 0;
    overflow: hidden;
    padding-top: 27px;

    .monaco-body {
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;

        .monaco-editor-layer {
            position: absolute;
            inset: 0;
            transition: opacity 0.12s ease;
        }
    }

    .monaco-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        font-size: var(--font-size-md);
    }

    .monaco-status {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 26px;
        padding: 0 10px;
        font-size: var(--font-size-xs);

        .monaco-status-path {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .monaco-status-lang {
            flex-shrink: 0;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .monaco-status-hint {
            flex-shrink: 0;
        }
    }
}
</style>
