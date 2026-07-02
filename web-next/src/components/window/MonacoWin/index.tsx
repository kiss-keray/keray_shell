"use client";

import { emitTo, TauriEvent, UnlistenFn } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useRef, useState } from "react";
import GlobalButton from "@/components/GlobalButton";
import MonacoEditor, { type MonacoEditorExpose, type MonacoEditorModelSpec } from "@/components/monaco/MonacoEditor";
import MonacoEditorTabs, { type MonacoTabItem } from "@/components/monaco/MonacoEditorTabs";
import { languageFromPath } from "@/components/monaco/monacoEnv";
import { useAppStore } from "@/stores/app";
import { useLocalStore } from "@/stores/localstore";
import { useServerDataStore, type ServerDataModel } from "@/stores/serverData";
import { baseName, oneFileRemoteItem, sftpReadFileStream, writeLocalFileToRemote } from "@/utils/fsUtil";
import { removeLocalIfAny } from "@/utils/localFsUtils";
import { showConfirm } from "@/utils/ui";
import { MONACO_EDITOR_ADD_ITEM, MONACO_EDITOR_SAVED_EVENT, type MonacoEditorSavedPayload, type MonacoEditorWindowPayload } from "@/utils/window";
import { uuid } from "@/utils";
import "./index.scss";

/** 编辑器内单个文件的状态 */
export type MonacoEditorFile = {
    key: string;
    content: string;
    savedContent: string;
    language: string;
    downloadProcess: number;
    uploadProcess: number;
    loading: boolean;
    saving: boolean;
    dirty: boolean;
    zIndex: number;
    server: ServerDataModel | null;
} & MonacoEditorWindowPayload;

function fileKey(payload: Pick<MonacoEditorWindowPayload, "sessionId" | "path">) {
    return `${payload.sessionId}::${payload.path}`;
}

function normalizePayloads(payload: MonacoEditorWindowPayload | MonacoEditorWindowPayload[]): MonacoEditorWindowPayload[] {
    return Array.isArray(payload) ? payload : [payload];
}

export default function MonacoWin() {
    const windowInitData = useAppStore((state) => state.windowInitData) as MonacoEditorWindowPayload | MonacoEditorWindowPayload[] | null;
    const setLoadingText = useAppStore((state) => state.setLoadingText);
    const tempRootDir = useLocalStore((state) => state.tempRootDir);
    const [editFiles, setEditFiles] = useState<MonacoEditorFile[]>([]);
    const [activeKey, setActiveKeyState] = useState("");
    const [, setActiveEditorZIndex] = useState(0);
    const editFilesRef = useRef<MonacoEditorFile[]>([]);
    const editorRefs = useRef(new Map<string, MonacoEditorExpose>());

    const tabItems = useMemo<MonacoTabItem[]>(
        () =>
            editFiles.map((f) => ({
                key: f.key,
                title: baseName(f.path),
                dirty: f.dirty,
                loading: f.loading,
                saving: f.saving,
            })),
        [editFiles],
    );
    const activeFile = useMemo(() => editFiles.find((f) => f.key === activeKey) ?? null, [activeKey, editFiles]);

    useEffect(() => {
        setLoadingText("正在打开...");
    }, [setLoadingText]);

    useEffect(() => {
        editFilesRef.current = editFiles;
    }, [editFiles]);

    useEffect(() => {
        if (!windowInitData) return;
        void openPayloads(normalizePayloads(windowInitData));
        // 初始化 payload 只响应 store 中的新窗口数据；openPayloads 内部会处理已打开文件聚焦。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windowInitData]);

    useEffect(() => {
        const win = getCurrentWindow();
        let unlistenAdd: UnlistenFn = () => {};
        let unlistenClose: UnlistenFn = () => {};
        win.listen<MonacoEditorWindowPayload | MonacoEditorWindowPayload[]>(MONACO_EDITOR_ADD_ITEM, async ({ payload }) => {
            await openPayloads(normalizePayloads(payload));
        }).then((fn) => {
            unlistenAdd = fn;
        });
        win.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
            if (editFilesRef.current.some((f) => f.dirty)) {
                const ok = await showConfirm({
                    title: "确定关闭",
                    message: "有未保存的修改，确定关闭吗？",
                    danger: true,
                });
                if (ok) await win.destroy();
            } else {
                await win.destroy();
            }
        }).then((fn) => {
            unlistenClose = fn;
        });
        return () => {
            unlistenAdd();
            unlistenClose();
        };
        // Vue 版监听只注册一次并通过响应式 editFiles 读取最新状态；这里用 ref 保持同样生命周期。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function setFiles(updater: (files: MonacoEditorFile[]) => MonacoEditorFile[]) {
        setEditFiles((files) => {
            const next = updater(files);
            editFilesRef.current = next;
            return next;
        });
    }

    function toEditorModel(file: MonacoEditorFile): MonacoEditorModelSpec {
        return {
            key: file.key,
            path: file.path,
            content: file.content,
            language: file.language,
            readOnly: file.loading || file.saving,
        };
    }

    function editorLayerStyle(file: MonacoEditorFile): React.CSSProperties {
        return {
            zIndex: file.zIndex,
            opacity: file.key === activeKey ? 1 : 0,
            pointerEvents: file.key === activeKey ? "auto" : "none",
        };
    }

    function setEditorRef(key: string, editor: MonacoEditorExpose | null) {
        if (editor) editorRefs.current.set(key, editor);
        else editorRefs.current.delete(key);
    }

    function setActiveKey(key: string) {
        setActiveEditorZIndex((prev) => {
            const nextZ = prev + 1;
            setFiles((files) => files.map((file) => (file.key === key ? { ...file, zIndex: nextZ } : file)));
            return nextZ;
        });
        setActiveKeyState(key);
    }

    function getEditorContent(key: string) {
        return editorRefs.current.get(key)?.getContent() ?? editFiles.find((f) => f.key === key)?.content ?? "";
    }

    async function openPayloads(payloads: MonacoEditorWindowPayload[]) {
        for (const payload of payloads) {
            const key = fileKey(payload);
            if (editFilesRef.current.some((f) => f.key === key)) {
                setActiveKey(key);
                continue;
            }
            const file = payloadToFile(payload);
            setFiles((prev) => (prev.some((item) => item.key === file.key) ? prev : [...prev, file]));
            setActiveKey(file.key);
            void downloadFile(file);
        }
    }

    function payloadToFile(payload: MonacoEditorWindowPayload): MonacoEditorFile {
        return {
            key: fileKey(payload),
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
    }

    function updateFile(key: string, patch: Partial<MonacoEditorFile>) {
        setFiles((files) => files.map((file) => (file.key === key ? { ...file, ...patch } : file)));
    }

    async function downloadFile(file: MonacoEditorFile) {
        await useServerDataStore.getState().initTask;
        const server = useServerDataStore.getState().findServerDataById(file.serverId);
        const remotePath = file.linkPath || file.path;
        const item = await oneFileRemoteItem(file.serverId, remotePath);
        setLoadingText("");
        if (!server || !item) {
            updateFile(file.key, { loading: false, content: "# 文件不存在或服务器不可用" });
            return;
        }
        let received = 0;
        const total = item.size || 0;
        try {
            let content = "";
            await sftpReadFileStream(server.id, remotePath, 0, (chunk) => {
                content += new TextDecoder().decode(chunk);
                received += chunk.length;
                const downloadProcess = total > 0 ? (received / total) * 100 : 100;
                if (downloadProcess === 100) {
                    updateFile(file.key, {
                        server,
                        content,
                        savedContent: content,
                        loading: false,
                        downloadProcess: 100,
                    });
                } else {
                    updateFile(file.key, {
                        server,
                        downloadProcess,
                        content: `数据加载中...${downloadProcess.toFixed(2)}%`,
                    });
                }
            });
        } catch (e) {
            console.error("下载文件失败", e);
            updateFile(file.key, {
                loading: false,
                downloadProcess: 100,
                content: `# 下载失败: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    async function fileSave(key: string) {
        const file = editFiles.find((f) => f.key === key);
        if (!file || file.loading || file.saving) return;
        const server = useServerDataStore.getState().findServerDataById(file.serverId);
        if (!server) return;
        const content = getEditorContent(key);
        updateFile(key, { content, saving: true, uploadProcess: 0 });
        let tempPath = "";
        try {
            tempPath = await join(await tempRootDir, `${uuid()}_${baseName(file.path)}`);
            await writeTextFile(tempPath, content, { create: true });
            await writeLocalFileToRemote(server.id, file.path, tempPath, (process) => updateFile(key, { uploadProcess: process }));
            updateFile(key, { savedContent: content, dirty: false });
            await emitTo<MonacoEditorSavedPayload>({ kind: "Window", label: file.from }, MONACO_EDITOR_SAVED_EVENT, {
                sessionId: file.sessionId,
                path: file.path,
            });
        } catch (e) {
            console.error("保存文件失败", e);
        } finally {
            updateFile(key, { saving: false, uploadProcess: 0 });
            if (tempPath) await removeLocalIfAny(tempPath);
        }
    }

    function onEditorChange(key: string, content: string) {
        const file = editFiles.find((f) => f.key === key);
        if (!file || file.loading) return;
        updateFile(key, { content, dirty: content !== file.savedContent });
    }

    function onTabSelect(key: string) {
        setActiveKey(key);
        requestAnimationFrame(() => editorRefs.current.get(key)?.focus());
    }

    function removeTabAt(idx: number) {
        const file = editFiles[idx];
        if (!file) return;
        editorRefs.current.delete(file.key);
        const nextFiles = editFiles.filter((_, i) => i !== idx);
        setFiles(() => nextFiles);
        if (activeKey === file.key) {
            const next = nextFiles[Math.min(idx, nextFiles.length - 1)];
            if (next) setActiveKey(next.key);
            else setActiveKeyState("");
        }
        if (nextFiles.length === 0) void getCurrentWindow().destroy();
    }

    async function onTabClose(key: string) {
        const idx = editFiles.findIndex((f) => f.key === key);
        if (idx < 0) return;
        const file = editFiles[idx]!;
        if (file.saving) return;
        const latest = getEditorContent(key);
        const dirty = latest !== file.savedContent;
        if (dirty) {
            const ok = await showConfirm({
                title: "关闭文件",
                message: `"${baseName(file.path)}" 有未保存的修改，确定关闭吗？`,
                danger: true,
            });
            if (!ok) return;
        }
        removeTabAt(idx);
    }

    return (
        <main className="MonacoWin">
            <GlobalButton bts={["setting", "theme", "themeMode"]} />
            <div className="monaco-editor-win">
                <MonacoEditorTabs tabs={tabItems} activeKey={activeKey} onSelect={onTabSelect} onClose={(key) => void onTabClose(key)} />
                <div className="monaco-body">
                    {editFiles.map((file) => (
                        <MonacoEditor
                            key={file.key}
                            ref={(editor) => setEditorRef(file.key, editor)}
                            className="monaco-editor-layer"
                            style={editorLayerStyle(file)}
                            file={toEditorModel(file)}
                            onChange={(content) => onEditorChange(file.key, content)}
                            onSave={() => void fileSave(file.key)}
                        />
                    ))}
                </div>
                {activeFile ? (
                    <div className="monaco-status">
                        <span className="monaco-status-path" title={activeFile.path}>
                            {activeFile.server?.name}:{activeFile.path}
                        </span>
                        {activeFile.loading ? <span className="monaco-status-hint">下载中 {Math.round(activeFile.downloadProcess)}%</span> : null}
                        {!activeFile.loading && activeFile.saving ? <span className="monaco-status-hint">保存中 {Math.round(activeFile.uploadProcess)}%</span> : null}
                        {!activeFile.loading && !activeFile.saving && activeFile.dirty ? <span className="monaco-status-hint">未保存</span> : null}
                        {!activeFile.loading && !activeFile.saving && !activeFile.dirty ? <span className="monaco-status-hint">已保存</span> : null}
                    </div>
                ) : null}
            </div>
        </main>
    );
}
