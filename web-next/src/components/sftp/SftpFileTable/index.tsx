"use client";

import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename as localBasename, extname, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, stat, writeFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "@/components/Icon";
import type { MenuItem } from "@/components/DefaultMenuItems";
import SystemInput from "@/components/SystemInput";
import { useSftpContext } from "@/components/sftp/context";
import { addFileItem, changeFileItemName, changeFileItemPermissions, compareNameLikeExplorer, deleteFileItem, findTreeItem, loadDirectory, type FileStoreItem } from "@/components/sftp/model";
import useBus, {
    ActiveFileEventKey,
    DirectRemotePathEventKey,
    DownloadMenuOpenEventKey,
    FileDragEndEventKey,
    FileDragStartEventKey,
    RefreshFileListEventKey,
    SftpProcessEventKey,
    UploadFileEventKey,
} from "@/hooks/useBus";
import { useAppStore } from "@/stores/app";
import { useDownloadStore } from "@/stores/downloadStore";
import { useKeyEventStore } from "@/stores/keyEvent";
import { useLocalStore } from "@/stores/localstore";
import { useChannelInstancesStore } from "@/stores/channelInstances";
import {
    baseName,
    checkLinuxFileName,
    listRemoteSubFiles,
    oneFileRemoteItem,
    pathAllParentPaths,
    remoteCopy,
    remoteJoin,
    remoteMove,
    resolveRemoteHome,
    sftpReadFileStream,
    writeLocalFileToRemote,
} from "@/utils/fsUtil";
import { CustomMenusEventKey } from "@/utils/constant";
import { copyText, dragListener, formatAdaptiveBytes, invoke } from "@/utils/project";
import { deepClone, treeForEach, uuid } from "@/utils";
import { buildDeleteConfirmMessage, buildMoveConfirmMessage } from "@/utils/confirmMessage";
import { showConfirm, showPermissionEditor, showPrompt, showToast } from "@/utils/ui";
import { MONACO_EDITOR_SAVED_EVENT, openOrFocusMonacoEditorWindow, type MonacoEditorSavedPayload } from "@/utils/window";
import "./index.scss";
import { UnlistenFn } from "@tauri-apps/api/event";

type ColKey = "name" | "size" | "type" | "mtime" | "perm" | "owner";
type SortOrder = "asc" | "desc";

const COL_KEYS: ColKey[] = ["name", "size", "type", "mtime", "perm", "owner"];
const COL_MIN: Record<ColKey, number> = {
    name: 80,
    size: 56,
    type: 48,
    mtime: 120,
    perm: 72,
    owner: 80,
};
const FILE_EXT_ICONS: Record<string, string> = {
    txt: "mdi:file-document-outline",
    log: "mdi:file-document-outline",
    md: "mdi:file-document-outline",
    rst: "mdi:file-document-outline",
    zip: "mdi:zip-box",
    rar: "mdi:zip-box",
    "7z": "mdi:zip-box",
    tar: "mdi:zip-box",
    gz: "mdi:zip-box",
    bz2: "mdi:zip-box",
    xz: "mdi:zip-box",
    tgz: "mdi:zip-box",
    doc: "mdi:file-word-outline",
    docx: "mdi:file-word-outline",
    xls: "mdi:file-excel-outline",
    xlsx: "mdi:file-excel-outline",
    csv: "mdi:file-excel-outline",
    ppt: "mdi:file-powerpoint-outline",
    pptx: "mdi:file-powerpoint-outline",
    odt: "mdi:file-word-outline",
    ods: "mdi:file-excel-outline",
    odp: "mdi:file-powerpoint-outline",
    pdf: "mdi:file-pdf-box",
    png: "mdi:file-image-outline",
    jpg: "mdi:file-image-outline",
    jpeg: "mdi:file-image-outline",
    gif: "mdi:file-image-outline",
    webp: "mdi:file-image-outline",
    bmp: "mdi:file-image-outline",
    ico: "mdi:file-image-outline",
    svg: "mdi:file-image-outline",
    tif: "mdi:file-image-outline",
    tiff: "mdi:file-image-outline",
    heic: "mdi:file-image-outline",
    mp4: "mdi:file-video-outline",
    mkv: "mdi:file-video-outline",
    avi: "mdi:file-video-outline",
    mov: "mdi:file-video-outline",
    webm: "mdi:file-video-outline",
    mp3: "mdi:file-music-outline",
    wav: "mdi:file-music-outline",
    flac: "mdi:file-music-outline",
    ogg: "mdi:file-music-outline",
    m4a: "mdi:file-music-outline",
    aac: "mdi:file-music-outline",
    js: "mdi:language-javascript",
    mjs: "mdi:language-javascript",
    cjs: "mdi:language-javascript",
    ts: "mdi:language-typescript",
    tsx: "mdi:language-typescript",
    jsx: "mdi:language-javascript",
    vue: "mdi:vuejs",
    html: "mdi:language-html5",
    htm: "mdi:language-html5",
    css: "mdi:language-css3",
    scss: "mdi:sass",
    sass: "mdi:sass",
    less: "mdi:file-code-outline",
    json: "mdi:code-json",
    yaml: "mdi:file-code-outline",
    yml: "mdi:file-code-outline",
    xml: "mdi:file-code-outline",
    toml: "mdi:file-code-outline",
    ini: "mdi:file-cog-outline",
    env: "mdi:file-cog-outline",
    sh: "mdi:bash",
    bash: "mdi:bash",
    zsh: "mdi:bash",
    py: "mdi:language-python",
    rb: "mdi:language-ruby",
    rs: "mdi:language-rust",
    go: "mdi:language-go",
    c: "mdi:language-c",
    h: "mdi:language-c",
    cpp: "mdi:language-cpp",
    cxx: "mdi:language-cpp",
    cc: "mdi:language-cpp",
    hpp: "mdi:language-cpp",
    java: "mdi:language-java",
    kt: "mdi:language-kotlin",
    swift: "mdi:language-swift",
    php: "mdi:language-php",
    sql: "mdi:database-search-outline",
    exe: "mdi:application-outline",
    dll: "mdi:application-outline",
    dmg: "mdi:package-variant",
    deb: "mdi:package-variant",
    rpm: "mdi:package-variant",
    msi: "mdi:application-outline",
    appimage: "mdi:application-outline",
    apk: "mdi:android",
    ipa: "mdi:apple",
};

const NON_EDITABLE_EXTS = new Set([
    "zip",
    "rar",
    "7z",
    "tar",
    "gz",
    "bz2",
    "xz",
    "tgz",
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "o",
    "a",
    "class",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "bmp",
    "ico",
    "tif",
    "tiff",
    "heic",
    "mp4",
    "mkv",
    "avi",
    "mov",
    "webm",
    "mp3",
    "wav",
    "flac",
    "ogg",
    "m4a",
    "aac",
    "pdf",
    "apk",
    "ipa",
    "dmg",
    "deb",
    "rpm",
    "msi",
    "appimage",
]);

const MAX_OPEN_SIZE = 1024 * 1024;

function fileExtension(name: string): string {
    const lower = name.toLowerCase();
    const i = lower.lastIndexOf(".");
    if (i <= 0 || i === lower.length - 1) return "";
    return lower.slice(i + 1);
}

function rowNameIcon(row: FileStoreItem): string {
    if (row.isDir) return row.children !== null ? "mdi:folder" : "mdi:folder-outline";
    return FILE_EXT_ICONS[fileExtension(baseName(row.id))] ?? "mdi:file-outline";
}

function isEditableTextFile(row: FileStoreItem): boolean {
    return !row.isDir && !NON_EDITABLE_EXTS.has(fileExtension(baseName(row.id)));
}

function formatPermissionSymbolic(row: FileStoreItem): string {
    const permBits = row.permissions ?? 0;
    const userExec = (permBits & 0o100) !== 0;
    const groupExec = (permBits & 0o010) !== 0;
    const otherExec = (permBits & 0o001) !== 0;
    const setuid = (permBits & 0o4000) !== 0;
    const setgid = (permBits & 0o2000) !== 0;
    const sticky = (permBits & 0o1000) !== 0;
    const user = `${(permBits & 0o400) !== 0 ? "r" : "-"}${(permBits & 0o200) !== 0 ? "w" : "-"}${setuid ? (userExec ? "s" : "S") : userExec ? "x" : "-"}`;
    const group = `${(permBits & 0o040) !== 0 ? "r" : "-"}${(permBits & 0o020) !== 0 ? "w" : "-"}${setgid ? (groupExec ? "s" : "S") : groupExec ? "x" : "-"}`;
    const other = `${(permBits & 0o004) !== 0 ? "r" : "-"}${(permBits & 0o002) !== 0 ? "w" : "-"}${sticky ? (otherExec ? "t" : "T") : otherExec ? "x" : "-"}`;
    return `${row.isDir ? "d" : "-"}${user}${group}${other}`;
}

function compareNullableNumber(a: number | null, b: number | null): number {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a - b;
}

function compareRows(a: FileStoreItem, b: FileStoreItem, key: ColKey): number {
    if (key === "name") {
        const an = `${a.isDir ? "d_" : "f_"}${baseName(a.id)}`;
        const bn = `${b.isDir ? "d_" : "f_"}${baseName(b.id)}`;
        return compareNameLikeExplorer(an, bn);
    }
    if (key === "size") return compareNullableNumber(a.size, b.size);
    if (key === "type") return a.isDir ? 1 : -1;
    if (key === "mtime") return compareNullableNumber(a.updatedAt, b.updatedAt);
    // Vue 版权限/用户列没有单独排序逻辑，会继续回退到文件名排序。
    return 0;
}

export default function SftpFileTable() {
    const { server, rootFile, activeItem, refreshTree, setActiveItem } = useSftpContext();
    const appOsType = useAppStore((state) => state.osType);
    const appHomeDir = useAppStore((state) => state.homeDir);
    const setLoadingText = useAppStore((state) => state.setLoadingText);
    const addDownloadTask = useDownloadStore((state) => state.addDownloadTask);
    const addUploadTask = useDownloadStore((state) => state.addUploadTask);
    const registerKeyEvent = useKeyEventStore((state) => state.register);
    const localStore = useLocalStore();
    const { on, emit } = useBus();
    const tableWrapRef = useRef<HTMLDivElement | null>(null);
    const initialized = useRef(false);
    const uiActive = useRef(true);
    const activeItemRef = useRef(activeItem);
    const fileChangeRef = useRef<(id: string) => void>(() => {});
    const handleTableKeyDownRef = useRef<(event: React.KeyboardEvent) => boolean>(() => false);
    const resizeState = useRef<{ key: ColKey; startX: number; startW: number } | null>(null);
    const draggingIdsRef = useRef<Set<string> | null>(null);
    const [sortState, setSortState] = useState<{ key: ColKey; order: SortOrder }>({ key: "name", order: "asc" });
    const [colWidths, setColWidths] = useState<Record<ColKey, number>>({ name: 210, size: 88, type: 72, mtime: 158, perm: 96, owner: 128 });
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [renameItem, setRenameItem] = useState<FileStoreItem | null>(null);
    const [editName, setEditName] = useState("");
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
    const [draggingIds, setDraggingIds] = useState<Set<string> | null>(null);
    const items = useMemo(() => {
        activeItemRef.current = activeItem;
        console.log("items..........", activeItem, activeItem.children);
        return activeItem.children || [];
    }, [activeItem]);

    const showRows = useMemo(() => {
        const sign = sortState.order === "asc" ? 1 : -1;
        return [...items].sort((a, b) => {
            const primary = compareRows(a, b, sortState.key);
            if (primary !== 0) return primary * sign;
            return compareRows(a, b, "name");
        });
    }, [items, sortState]);
    const selectedItems = useMemo(() => showRows.filter((item) => selectedIds.has(item.id)), [selectedIds, showRows]);
    const tableWidthPx = COL_KEYS.reduce((acc, key) => acc + colWidths[key], 0);

    function updateSelection(next: Set<string>) {
        setSelectedIds(new Set(next));
    }

    const commitTree = useCallback(
        (selectPath = activeItemRef.current.id, clearSelection = true) => {
            const selected = findTreeItem(rootFile, selectPath) ?? findTreeItem(rootFile, activeItemRef.current.id) ?? rootFile;
            console.log("commitTree..........", selected, selected.children);
            if (clearSelection) setSelectedIds(new Set());
            setActiveItem(selected);
            refreshTree();
        },
        [rootFile, setActiveItem, refreshTree],
    );

    const loadFileItem = useCallback(
        async (parent: FileStoreItem, force = false) => {
            setLoading(!force);
            try {
                await loadDirectory(server.server.id, parent, force);
                commitTree(parent.id);
            } catch (err) {
                console.error("load remote directory error:", err);
                showToast("读取远程目录失败", "error");
            } finally {
                setLoading(false);
            }
        },
        [server.server.id, commitTree],
    );

    const directLoadPath = useCallback(
        async (path: string) => {
            setLoading(true);
            const setChildren = (parent: FileStoreItem, children: FileStoreItem[]) => {
                parent.children = children;
                // Vue 版在 directLoadPath 内手动补 parent/level；Next 这里保持同样的数据修补方式。
                parent.children.forEach((item) => {
                    item.level = parent.level + 1;
                    item.parent = parent;
                });
                parent.leaf = parent.children.length === 0;
            };
            try {
                const findParentFile = async (): Promise<FileStoreItem> => {
                    const parentPaths = pathAllParentPaths(path);
                    let parent: FileStoreItem | null = null;
                    for (const parentPath of parentPaths) {
                        if (parentPath === rootFile.id) {
                            parent = rootFile;
                        } else {
                            parent = parent!.children!.find((item) => item.id === parentPath) ?? null;
                        }
                        if (!parent) throw new Error("文件不存在");
                        if (parent.id === path) {
                            return parent;
                        }
                        if (parent.children === null) {
                            parent.loading = true;
                            const children = (await listRemoteSubFiles(server.server.id, parent.id)) as FileStoreItem[];
                            setChildren(parent, children);
                            parent.loading = false;
                        }
                    }
                    throw new Error("文件不存在");
                };
                const loadFiles = async (): Promise<FileStoreItem[] | null> => {
                    const haveLoad = treeForEach<FileStoreItem>(rootFile, (item) => {
                        if (item.id === path) {
                            return item.children !== null;
                        }
                        return false;
                    });
                    if (haveLoad) return null;
                    return (await listRemoteSubFiles(server.server.id, path)) as FileStoreItem[];
                };
                const [parent, files] = await Promise.all([findParentFile(), loadFiles()]);
                if (files) setChildren(parent, files);
                commitTree(parent.id);
            } catch (err) {
                console.error("direct load remote directory error:", err);
                showToast("读取远程目录失败", "error");
            } finally {
                setLoading(false);
            }
        },
        [server.server.id, commitTree, rootFile],
    );

    const clickDownload = useCallback(
        (nextItems: FileStoreItem[]) => {
            setLoadingText("下载任务生成中...");
            const promise = addDownloadTask(
                { sessionId: server.sessionId, serverId: server.server.id },
                nextItems.map((item) => item.id),
            );
            promise
                .catch((err) => {
                    console.error(err);
                    showToast("下载任务生成失败", "error");
                })
                .finally(() => setLoadingText(""));
        },
        [server.sessionId, server.server.id, addDownloadTask, setLoadingText],
    );

    const uploadFiles = useCallback(
        (paths: string[], fileItem: FileStoreItem = activeItemRef.current) => {
            const dirItem = fileItem.isDir ? fileItem : fileItem.parent;
            if (!dirItem || !dirItem.isDir) {
                showToast("请选择上传文件夹", "error");
                return;
            }
            const remoteDir = dirItem.linkPath || dirItem.id;
            addUploadTask({ sessionId: server.sessionId, serverId: server.server.id }, paths, remoteDir, () => {
                void loadFileItem(dirItem, true);
            });
        },
        [server.sessionId, server.server.id, addUploadTask, loadFileItem],
    );

    const clickUpload = useCallback(
        async (row: FileStoreItem, directory = true) => {
            const uploadDefaultPath = await appHomeDir;
            if (appOsType === "macos") {
                const paths = await invoke<string[]>("pick_file_or_folder", { title: "上传", multiple: true, defaultPath: uploadDefaultPath });
                if (!paths) return;
                uploadFiles(paths, row);
                return;
            }
            const result = await open({ title: "上传", multiple: true, directory, defaultPath: uploadDefaultPath });
            if (!result) return;
            uploadFiles(Array.isArray(result) ? result : [result], row);
        },
        [appOsType, appHomeDir, uploadFiles],
    );

    const handleOpen = useCallback(
        (nextItems: FileStoreItem[]) => {
            if (nextItems.length === 1 && nextItems[0].isDir) {
                void loadFileItem(nextItems[0]);
                return;
            }
            const files = nextItems.filter((item) => !item.isDir && item.size !== null);
            if (!files.length) return;
            if (files.some((item) => item.size! > MAX_OPEN_SIZE)) {
                showToast("文件大小超过1MB，无法打开", "warning");
                return;
            }
            void openOrFocusMonacoEditorWindow(
                files.map((item) => ({
                    sessionId: server.sessionId,
                    serverId: server.server.id,
                    path: item.id,
                    linkPath: item.linkPath,
                    from: getCurrentWindow().label,
                })),
            );
        },
        [server.sessionId, server.server.id, loadFileItem],
    );

    const confirmAddName = useCallback(
        async (name: string, isDir = true) => {
            const newName = name.trim();
            if (!newName) {
                return;
            }
            if (!checkLinuxFileName(newName)) {
                showToast("文件名不符合 Linux 文件系统命名规则", "error");
                return;
            }
            await addFileItem(server.server.id, activeItemRef.current, newName, isDir);
            commitTree(activeItemRef.current.id);
        },
        [server.server.id, commitTree],
    );

    async function fileChange(id: string) {
        const changed = findTreeItem(rootFile, id);
        if (!changed) return;
        const newItem = await oneFileRemoteItem(server.server.id, changed.linkPath || changed.id);
        if (!newItem) return;
        changed.size = newItem.size;
        changed.updatedAt = newItem.updatedAt;
        changed.permissions = newItem.permissions;
        refreshTree();
    }
    fileChangeRef.current = (id: string) => {
        void fileChange(id);
    };

    async function openFileWithSystem(path: string, appPath: string | null): Promise<void> {
        if (!appPath) return;
        await invoke("open_file_with_app", { appPath, filePath: path });
    }

    async function selectLocalApp(haveSelectedApp: string[]): Promise<string | null> {
        const defaultAppDir = appOsType === "macos" ? "/Applications" : appOsType === "windows" ? "C:\\Program Files" : undefined;
        const appPath = await open({ title: "选择打开方式", multiple: false, defaultPath: defaultAppDir });
        if (!appPath || Array.isArray(appPath)) return null;
        haveSelectedApp.remove(appPath);
        haveSelectedApp.unshift(appPath);
        await localStore.writeCache("SELECTED_OPEN_APP", haveSelectedApp);
        return appPath;
    }

    async function openFileByLocal(item: FileStoreItem, appPath?: string) {
        if (item.size === null) return;
        if (item.size > MAX_OPEN_SIZE) {
            showToast("文件大小超过1MB，无法打开", "warning");
            return;
        }
        setLoadingText("文件打开中...");
        const uid = uuid();
        const dir = await join(await localStore.tempRootDir, uid);
        const file = await join(dir, baseName(item.id));
        const haveSelectedApp = (await localStore.readCache<string[]>("SELECTED_OPEN_APP")) || [];
        await mkdir(dir, { recursive: true });

        async function openAndWatchLocalFile() {
            // 系统应用编辑通过临时文件中转；轮询 mtime 后写回远端，保持和 Vue 版一致。
            const statInfo = await stat(file);
            let mtime = statInfo.mtime;
            let count = 0;
            const task = async () => {
                if (count++ > 2 * 60 * 10 || !uiActive.current) return;
                const nextStat = await stat(file);
                if (mtime?.getTime() !== nextStat.mtime?.getTime()) {
                    await writeLocalFileToRemote(server.server.id, item.id, file, (process) => emit(SftpProcessEventKey, process));
                    await fileChange(item.id);
                    mtime = nextStat.mtime;
                }
                window.setTimeout(() => void task(), 500);
            };
            await openFileWithSystem(file, appPath ?? (await selectLocalApp(haveSelectedApp)));
            void task();
        }

        try {
            if (item.size === 0) {
                await writeFile(file, new Uint8Array(), { create: true });
                await openAndWatchLocalFile();
                return;
            }
            let getSize = 0;
            await sftpReadFileStream(server.server.id, item.id, 0, (chunk) => {
                void writeFile(file, chunk, { append: true, create: true });
                getSize += chunk.length;
                emit(SftpProcessEventKey, (getSize / item.size!) * 100);
            });
            await openAndWatchLocalFile();
        } finally {
            setLoadingText("");
        }
    }

    async function moveFiles(moveItems: FileStoreItem[], dirItem: FileStoreItem, cut = false) {
        if (!moveItems.length) return;
        const ok = await showConfirm({
            title: cut ? "确认剪切文件吗？" : "确认复制文件吗？",
            message: buildMoveConfirmMessage(moveItems, dirItem.id),
            danger: true,
        });
        if (!ok) return;
        for (const moveItem of moveItems) {
            const newPath = await remoteJoin(dirItem.id, baseName(moveItem.id));
            if (cut) {
                await remoteMove(server.server.id, moveItem.id, newPath);
                moveItem.parent?.children?.remove(moveItem);
            } else {
                await remoteCopy(server.server.id, moveItem.id, newPath);
            }
        }
        await loadDirectory(server.server.id, dirItem, true);
        commitTree(activeItemRef.current.id);
    }

    async function handleDelete(nextItems: FileStoreItem[]) {
        if (!nextItems.length) return;
        const ok = await showConfirm({ title: "确认删除", message: buildDeleteConfirmMessage(nextItems), danger: true });
        if (!ok) return;
        for (const item of nextItems) {
            await deleteFileItem(server.server.id, item).catch((err) => {
                console.error(err);
                showToast("删除失败", "error");
            });
        }
        commitTree(activeItemRef.current.id);
    }

    function toggleSort(key: ColKey) {
        setSortState((prev) => (prev.key === key ? { key, order: prev.order === "asc" ? "desc" : "asc" } : { key, order: "asc" }));
    }

    function sortIndicator(key: ColKey): string {
        if (sortState.key !== key) return "↕";
        return sortState.order === "asc" ? "↑" : "↓";
    }

    function applyShiftRangeSelection(index: number): boolean {
        if (anchorIndex === null) return false;
        const row = showRows[index];
        if (!row) return false;
        const up = anchorIndex > index;
        const down = anchorIndex < index;
        const rowBeforeIsSelected = selectedIds.has(row.id);
        if (down === up) return false;
        const next = new Set(selectedIds);
        // 对齐 Vue 版 Shift 点击：以锚点为中心扩展连续区间，回点已选区域时会收缩另一侧连续选择。
        const removeBefore = (from: number) => {
            for (let i = from - 1; i >= 0; i--) {
                const id = showRows[i].id;
                if (!next.has(id)) break;
                next.delete(id);
            }
        };
        const removeAfter = (from: number) => {
            for (let i = from + 1; i < showRows.length; i++) {
                const id = showRows[i].id;
                if (!next.has(id)) break;
                next.delete(id);
            }
        };
        if (up) {
            removeAfter(anchorIndex);
            for (let i = anchorIndex; i >= index; i--) next.add(showRows[i].id);
            if (rowBeforeIsSelected) removeBefore(index);
        } else if (down) {
            removeBefore(anchorIndex);
            for (let i = anchorIndex; i <= index; i++) next.add(showRows[i].id);
            if (rowBeforeIsSelected) removeAfter(index);
        }
        updateSelection(next);
        return true;
    }

    function handleRowClick(event: React.MouseEvent, row: FileStoreItem) {
        const index = showRows.indexOf(row);
        if (event.shiftKey && applyShiftRangeSelection(index)) {
            return;
        }
        setAnchorIndex(index);
        if (event.metaKey || event.ctrlKey) {
            const next = new Set(selectedIds);
            if (next.has(row.id)) next.delete(row.id);
            else next.add(row.id);
            updateSelection(next);
            return;
        }
        updateSelection(new Set([row.id]));
    }

    function moveSingleSelection(delta: number): boolean {
        if (!showRows.length || selectedItems.length !== 1) return false;
        const current = showRows.indexOf(selectedItems[0]);
        const nextIndex = (current + delta + showRows.length) % showRows.length;
        const row = showRows[nextIndex];
        updateSelection(new Set([row.id]));
        setAnchorIndex(nextIndex);
        autoScrollToRow(row);
        return true;
    }

    function extendSelectionByKeyboard(delta: number): boolean {
        if (!showRows.length || anchorIndex === null || !selectedIds.size) return false;
        const selectedIndexes = Array.from(selectedIds).map((id) => showRows.findIndex((item) => item.id === id));
        const up = selectedIndexes.includes(anchorIndex - 1);
        const down = selectedIndexes.includes(anchorIndex + 1);
        let startIndex = anchorIndex;
        let endIndex = anchorIndex;
        for (let i = anchorIndex; i >= 0 && i < showRows.length; i = up ? i - 1 : i + 1) {
            if (selectedIndexes.includes(i)) continue;
            if (up) {
                startIndex = i + 1;
                endIndex = anchorIndex;
            } else {
                startIndex = anchorIndex;
                endIndex = i - 1;
            }
            break;
        }
        let targetIndex: number;
        let remove = false;
        if (delta < 0) {
            if (up || up === down) {
                targetIndex = Math.max(0, startIndex - 1);
            } else {
                targetIndex = endIndex;
                remove = true;
            }
        } else if (down || up === down) {
            targetIndex = Math.min(showRows.length - 1, endIndex + 1);
        } else {
            targetIndex = startIndex;
            remove = true;
        }
        const item = showRows[targetIndex];
        if (!item) return false;
        if (remove) {
            const next = new Set(selectedIds);
            next.delete(item.id);
            updateSelection(next);
        } else {
            applyShiftRangeSelection(targetIndex);
        }
        autoScrollToRow(item);
        return true;
    }

    async function confirmName(blur = false) {
        if (!renameItem) return;
        const nextName = editName.trim();
        if (!nextName) {
            setRenameItem(null);
            return;
        }
        if (!checkLinuxFileName(nextName)) {
            showToast("文件名不符合 Linux 文件系统命名规则", "error");
            if (blur) setRenameItem(null);
            return;
        }
        await changeFileItemName(server.server.id, renameItem, nextName);
        setRenameItem(null);
        commitTree(renameItem.id);
    }

    async function chmod(row: FileStoreItem) {
        const perms = await showPermissionEditor({
            title: "修改文件权限",
            path: row.id,
            defaultValue: row.permissions,
            confirmText: "确定",
            cancelText: "取消",
        });
        if (perms === null) return;
        await changeFileItemPermissions(server.server.id, row, perms).catch((err) => {
            console.error(err);
            showToast("文件权限修改失败", "error");
        });
        commitTree(activeItemRef.current.id, false);
    }

    async function openRowContextMenu(event: React.MouseEvent, row: FileStoreItem) {
        event.preventDefault();
        event.stopPropagation();
        const offline = server.status !== "connected";
        const onlyOneBeforeContext = selectedIds.size < 2;
        if (onlyOneBeforeContext) updateSelection(new Set([row.id]));
        const effectiveItems = onlyOneBeforeContext ? [row] : showRows.filter((item) => selectedIds.has(item.id));
        const onlyOne = effectiveItems.length === 1;
        const canBulkEdit = effectiveItems.every(isEditableTextFile);
        const haveSelectedApp = (await localStore.readCache<string[]>("SELECTED_OPEN_APP")) || [];
        const menus: MenuItem[] = [
            { label: "打开", disabled: offline || !canBulkEdit, handler: () => handleOpen(effectiveItems) },
            {
                label: "打开方式",
                disabled: offline || !canBulkEdit,
                children: [
                    { label: "文本编辑器", disabled: !canBulkEdit, handler: () => handleOpen(effectiveItems) },
                    { label: "系统关联软件打开", disabled: !canBulkEdit || !onlyOne, handler: () => void openFileByLocal(effectiveItems[0]!) },
                    ...(haveSelectedApp.length
                        ? ([
                              "---",
                              ...(await Promise.all(
                                  haveSelectedApp.map(async (appPath) => {
                                      const name = await localBasename(appPath);
                                      const ext = await extname(appPath);
                                      const appImage = await invoke<string>("get_app_icon", { appPath });
                                      const label = ext ? name.replace(`.${ext}`, "") : name;
                                      return {
                                          label,
                                          image: appImage,
                                          disabled: !canBulkEdit,
                                          handler: () => void openFileByLocal(effectiveItems[0]!, appPath),
                                      } satisfies MenuItem;
                                  }),
                              )),
                          ] as MenuItem[])
                        : []),
                ],
            },
            { label: "刷新", disabled: offline, handler: () => void loadFileItem(activeItemRef.current, true) },
            "---",
            {
                label: "新建",
                disabled: offline,
                children: [
                    {
                        label: "文件夹",
                        handler: async () => {
                            const value = await showPrompt({ title: "新建文件夹", placeholder: "请输入文件夹名称", confirmText: "创建", cancelText: "取消" });
                            if (value === null) return;
                            await confirmAddName(value);
                        },
                    },
                    {
                        label: "文件",
                        handler: async () => {
                            const value = await showPrompt({ title: "新建文件", placeholder: "请输入文件名称", confirmText: "创建", cancelText: "取消" });
                            if (value === null) return;
                            await confirmAddName(value, false);
                        },
                    },
                ],
            },
            {
                label: "重命名",
                disabled: offline || !onlyOne,
                handler: () => {
                    setRenameItem(row);
                    setEditName(baseName(row.id));
                },
            },
            { label: "快速删除(rm命令)", disabled: offline, handler: () => void handleDelete(effectiveItems) },
            "---",
            {
                label: "复制路径",
                handler: () => {
                    void copyText(effectiveItems.map((item) => item.id).join("\n"));
                },
            },
            "---",
            { label: "下载", disabled: offline, handler: () => clickDownload(effectiveItems) },
            appOsType === "macos"
                ? {
                      label: "上传",
                      disabled: offline,
                      handler: () => void clickUpload(onlyOneBeforeContext ? row : activeItem),
                  }
                : {
                      label: "上传",
                      disabled: offline,
                      children: [
                          { label: "上传文件", handler: () => void clickUpload(onlyOneBeforeContext ? row : activeItem, false) },
                          { label: "上传文件夹", handler: () => void clickUpload(onlyOneBeforeContext ? row : activeItem) },
                      ],
                  },
            "---",
            { label: "文件权限…", disabled: offline || !onlyOne, handler: () => void chmod(effectiveItems[0]!) },
        ];
        document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: event.nativeEvent } }));
    }

    function autoScrollToRow(row: FileStoreItem) {
        tableWrapRef.current?.querySelector(`tr[data-id="${CSS.escape(row.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function updateNameColumnWidth() {
        const tableWidth = tableWrapRef.current?.getBoundingClientRect().width ?? 0;
        if (!tableWidth) return;
        setColWidths((prev) => ({
            ...prev,
            name: tableWidth - prev.size - prev.type - prev.mtime - prev.perm - prev.owner,
        }));
    }

    function handleTableKeyDown(event: KeyboardEvent | React.KeyboardEvent<HTMLDivElement>): boolean {
        if (event.key === "Escape" && renameItem) {
            setRenameItem(null);
            setEditName("");
            tableWrapRef.current?.focus();
            event.preventDefault();
            return true;
        }
        if (renameItem) return false;
        if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
            void handleDelete(selectedItems);
            event.preventDefault();
            return true;
        } else if (event.key === "Enter" && selectedItems.length === 1) {
            setRenameItem(selectedItems[0]);
            setEditName(baseName(selectedItems[0].id));
            event.preventDefault();
            return true;
        } else if (event.key === "ArrowUp") {
            const handled = event.shiftKey ? extendSelectionByKeyboard(-1) : moveSingleSelection(-1);
            if (!handled) return false;
            event.preventDefault();
            return true;
        } else if (event.key === "ArrowDown") {
            const handled = event.shiftKey ? extendSelectionByKeyboard(1) : moveSingleSelection(1);
            if (!handled) return false;
            event.preventDefault();
            return true;
        } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.shiftKey && selectedItems.length <= 1) {
            const start = selectedItems.length === 1 ? showRows.indexOf(selectedItems[0]) + 1 : 0;
            const key = event.key;
            const found = [...showRows.slice(start), ...showRows.slice(0, start)].find((row) => baseName(row.id).startsWith(key));
            if (found) {
                updateSelection(new Set([found.id]));
                autoScrollToRow(found);
                return true;
            }
        }
        return false;
    }
    handleTableKeyDownRef.current = handleTableKeyDown as (event: React.KeyboardEvent) => boolean;

    function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        handleTableKeyDown(event);
    }

    function startResize(key: ColKey, event: React.MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        resizeState.current = { key, startX: event.clientX, startW: colWidths[key] };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }

    function dragStart() {
        if (!selectedIds.size) return;
        const next = new Set(selectedIds);
        draggingIdsRef.current = next;
        setDraggingIds(next);
        emit(FileDragStartEventKey, selectedItems);
    }

    async function dropOnRow(event: React.DragEvent, row: FileStoreItem) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.classList.remove("drag-over");
        const ids = draggingIdsRef.current ?? draggingIds;
        if (!ids || !row.isDir) return;
        const droppedItems = items.filter((item) => ids.has(item.id) && item.id !== row.id);
        draggingIdsRef.current = null;
        setDraggingIds(null);
        await moveFiles(droppedItems, row, true);
    }

    useEffect(() => {
        const onMove = (event: MouseEvent) => {
            const state = resizeState.current;
            if (!state) return;
            const next = Math.max(COL_MIN[state.key], state.startW + event.clientX - state.startX);
            setColWidths((prev) => ({ ...prev, [state.key]: next }));
        };
        const onUp = () => {
            resizeState.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, []);

    useEffect(() => {
        updateNameColumnWidth();
        window.addEventListener("resize", updateNameColumnWidth);
        return () => window.removeEventListener("resize", updateNameColumnWidth);
    }, []);

    useEffect(() => {
        const table = tableWrapRef.current;
        if (!table) return;
        const unregisterKey = registerKeyEvent((event) => {
            if (document.activeElement !== table && !table.contains(document.activeElement)) return false;
            return handleTableKeyDownRef.current(event);
        });
        let unlistenDrag: UnlistenFn = () => {};
        void dragListener(() => Array.from(table.querySelectorAll<HTMLElement>(".data-row"))).then((unlisten) => {
            unlistenDrag = unlisten;
        });
        return () => {
            unregisterKey();
            unlistenDrag();
        };
    }, [registerKeyEvent]);

    // 真正加载文件下级的入口
    useEffect(() => {
        if (!initialized.current) {
            initialized.current = true;
            if (activeItem.id === "/" && activeItem.children === null) {
                void resolveRemoteHome(server.server.id)
                    .then((home) => directLoadPath(home))
                    .catch(() => directLoadPath("/"));
                return;
            }
        }
        if (activeItem.children === null) void loadFileItem(activeItem);
        else emit(ActiveFileEventKey, { sid: server.sessionId, path: activeItem.id });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeItem.id, server.sessionId]);

    useEffect(() => {
        return on(DirectRemotePathEventKey, (event) => {
            if (event.sid !== server.sessionId) return;
            void directLoadPath(event.path);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [on, rootFile, server.sessionId]);

    useEffect(() => on(RefreshFileListEventKey, () => void loadFileItem(activeItemRef.current, true)), [on, loadFileItem, rootFile]);
    useEffect(() => on(UploadFileEventKey, () => void clickUpload(activeItemRef.current)), [on, clickUpload, rootFile]);
    useEffect(
        () =>
            on(DownloadMenuOpenEventKey, () => {
                if (!selectedItems.length) return;
                clickDownload(selectedItems);
            }),
        [on, selectedItems, clickDownload],
    );

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;
        void getCurrentWindow()
            .listen<MonacoEditorSavedPayload>(MONACO_EDITOR_SAVED_EVENT, (event) => {
                if (disposed) return;
                const savedPath = event.payload.path;
                if (event.payload.sessionId === server.sessionId) fileChangeRef.current(savedPath);
            })
            .then((cleanup) => {
                unlisten = cleanup;
            });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [server.sessionId]);

    useEffect(() => {
        let unlistenDragDrop: UnlistenFn = () => {};
        getCurrentWindow()
            .onDragDropEvent(({ payload }) => {
                if (useChannelInstancesStore.getState().selectSessionId !== server.sessionId) return;
                if (payload.type !== "drop" || !payload.paths.length) return;
                const table = tableWrapRef.current;
                if (!table) return;
                let { x, y } = payload.position;
                if (appOsType === "windows") {
                    x = x / useAppStore.getState().scaleFactor;
                    y = y / useAppStore.getState().scaleFactor;
                }
                const rect = table.getBoundingClientRect();
                if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
                uploadFiles(payload.paths);
            })
            .then((unlisten) => {
                unlistenDragDrop = unlisten;
            });
        return () => {
            unlistenDragDrop();
        };
    }, [appOsType, rootFile, server.sessionId, uploadFiles]);

    useEffect(() => {
        uiActive.current = true;
        return () => {
            uiActive.current = false;
        };
    }, []);

    useEffect(() => {
        activeItemRef.current = activeItem;
    }, [activeItem]);

    useEffect(() => {
        server.snapshotFn.sftpFileTable = () => ({
            filePanelScrollTop: tableWrapRef.current?.scrollTop ?? 0,
            selectedIds: Array.from(selectedIds),
        });
    }, [selectedIds, server]);

    useEffect(() => {
        const snapshot = server.snapshot.sftpFileTable as
            | {
                  filePanelScrollTop?: number;
                  selectedIds?: string[];
              }
            | undefined;
        if (!snapshot) return;
        delete server.snapshot.sftpFileTable;
        if (snapshot.selectedIds) setSelectedIds(new Set(snapshot.selectedIds));
        // 表格内容随远端目录异步加载，滚动位置等下一帧 DOM 就绪后再恢复。
        window.setTimeout(() => {
            if (tableWrapRef.current && snapshot.filePanelScrollTop !== undefined) tableWrapRef.current.scrollTop = snapshot.filePanelScrollTop;
        }, 0);
    }, [server]);

    return (
        <div className="SftpFileTable table-wrap grow min-w-0 overflow-auto" ref={tableWrapRef} tabIndex={0} onKeyDown={handleKeyDown}>
            <table className="file-table text-left" style={{ width: `${tableWidthPx}px` }}>
                <colgroup>
                    {COL_KEYS.map((key) => (
                        <col key={key} className={`col-${key}`} style={{ width: `${colWidths[key]}px` }} />
                    ))}
                </colgroup>
                <thead>
                    <tr>
                        {[
                            { key: "name", label: "文件名" },
                            { key: "size", label: "大小" },
                            { key: "type", label: "类型" },
                            { key: "mtime", label: "修改时间" },
                            { key: "perm", label: "权限" },
                            { key: "owner", label: "用户/组" },
                        ].map((col) => (
                            <th key={col.key} className="th-resizable th-sortable" onClick={() => toggleSort(col.key as ColKey)}>
                                <div className="flex items-center">
                                    <span className="th-label">{col.label}</span>
                                    <span className={`th-sort-ind${sortState.key === col.key ? " active" : ""}`}>{sortIndicator(col.key as ColKey)}</span>
                                </div>
                                <span className="col-resize-handle" title="拖动调整列宽" onMouseDown={(event) => startResize(col.key as ColKey, event)} />
                            </th>
                        ))}
                    </tr>
                </thead>
                {loading || showRows.length === 0 ? (
                    <tbody>
                        <tr>
                            <td colSpan={6} className="px-3 py-6 text-center text-white/50 h-[100px]">
                                {loading ? "加载中…" : "暂无数据"}
                            </td>
                        </tr>
                    </tbody>
                ) : (
                    <tbody>
                        {showRows.map((row) => (
                            <tr
                                key={row.id}
                                data-id={row.id}
                                data-is-dir={row.isDir}
                                className={`data-row${selectedIds.has(row.id) ? " sel" : ""}`}
                                draggable
                                onClick={(event) => handleRowClick(event, row)}
                                onDoubleClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    handleOpen([row]);
                                }}
                                onContextMenu={(event) => void openRowContextMenu(event, row)}
                                onDragStart={dragStart}
                                onDragEnd={() => {
                                    window.setTimeout(() => {
                                        draggingIdsRef.current = null;
                                        setDraggingIds(null);
                                        emit(FileDragEndEventKey);
                                    }, 60);
                                }}
                                onDragOver={(event) => {
                                    if (draggingIds && row.isDir) {
                                        event.preventDefault();
                                        event.currentTarget.classList.add("drag-over");
                                    }
                                }}
                                onDragLeave={(event) => event.currentTarget.classList.remove("drag-over")}
                                onDrop={(event) => void dropOnRow(event, row)}
                            >
                                <td className="cell-name">
                                    {renameItem !== row ? (
                                        <span className="name-cell-inner">
                                            <span className="icon-stack text-base shrink-0">
                                                <Icon icon={rowNameIcon(row)} className={`icon-stack-main name-cell-ic${!row.isDir ? " icon-file-icon" : ""}`} />
                                                {row.linkPath ? <Icon icon="ion:arrow-redo" className="lnk-corner-ic" aria-hidden="true" /> : null}
                                            </span>
                                            <span className="name-text">{baseName(row.id)}</span>
                                        </span>
                                    ) : (
                                        <span className="name-cell-inner">
                                            <span className="icon-stack text-base shrink-0">
                                                <Icon icon={rowNameIcon(row)} className={`icon-stack-main name-cell-ic${!row.isDir ? " icon-file-icon" : ""}`} />
                                                {row.linkPath ? <Icon icon="ion:arrow-redo" className="icon-link-icon" aria-hidden="true" /> : null}
                                            </span>
                                            <SystemInput
                                                value={editName}
                                                onChange={setEditName}
                                                className="table-inline-input"
                                                onBlur={() => void confirmName(true)}
                                                onClick={(event) => event.stopPropagation()}
                                                onKeyDown={(event) => {
                                                    event.stopPropagation();
                                                    if (event.key === "Enter") void confirmName();
                                                    else if (event.key === "Escape") setRenameItem(null);
                                                }}
                                            />
                                        </span>
                                    )}
                                </td>
                                <td className="cell-numeric">{row.size !== null ? formatAdaptiveBytes(row.size) : ""}</td>
                                <td>{row.isDir ? "文件夹" : fileExtension(baseName(row.id))}</td>
                                <td className="cell-mtime">{row.updatedAt ? dayjs(new Date(row.updatedAt * 1000)).format("YYYY/MM/DD HH:mm") : ""}</td>
                                <td className="cell-perm font-mono text-xs">{formatPermissionSymbolic(row)}</td>
                                <td className="cell-owner text-xs">
                                    {row.owner}/{row.group}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                )}
            </table>
        </div>
    );
}
