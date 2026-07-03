<script setup lang="tsx">
import Draggable from "vuedraggable";

import { buildDeleteConfirmMessage, buildMoveConfirmMessage } from "@/utils/confirmMessage";
import { baseName, compareNameLikeExplorer, oneFileRemoteItem, remoteCopy, writeLocalFileToRemote } from "@/utils/fsUtil";
import { addFileItem, changeFileItemName, changeFileItemPermissions, deleteFileItem, loadDirectory, type FileStoreItem } from ".";
import { showPermissionEditor } from "./ui";
import { dragListener, formatAdaptiveBytes } from "@/utils/project";
import dayjs from "dayjs";
import useBus, {
    ActiveFileEventKey,
    DirectRemotePathEventKey,
    DownloadMenuOpenEventKey,
    FileDragEndEventKey,
    FileDragStartEventKey,
    RefreshFileListEventKey,
    SftpProcessEventKey,
    UploadFileEventKey,
} from "@/composables/useBus";
import { storeToRefs } from "pinia";
import { checkLinuxFileName } from "@/utils/fsUtil";
import { basename, extname, join } from "@tauri-apps/api/path";
import { mkdir, stat, writeFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { MONACO_EDITOR_SAVED_EVENT, openOrFocusMonacoEditorWindow, type MonacoEditorSavedPayload } from "@/utils/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { MenuItem } from "../DefaultMenuItems.vue";
import type { SystemInputExpose } from "../SystemInput.vue";

type ColKey = "name" | "size" | "type" | "mtime" | "perm" | "owner";
type SortOrder = "asc" | "desc";

const COL_KEYS: ColKey[] = ["name", "size", "type", "mtime", "perm", "owner"];

const MAX_OPEN_SIZE = 1024 * 1024 * 1; // 1MB // 最多打开1MB的文件

const COL_MIN: Record<ColKey, number> = {
    name: 80,
    size: 56,
    type: 48,
    mtime: 120,
    perm: 72,
    owner: 80,
};

const colWidths = reactive<Record<ColKey, number>>({
    name: 210,
    size: 88,
    type: 72,
    mtime: 158,
    perm: 96,
    owner: 128,
});

const tableWrapRef = ref<HTMLDivElement>();

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

type TermSnapshot = {
    fileTableScrollTop: number;
    selectedPaths: string[];
};

const props = defineProps<{
    rootFile: FileStoreItem;
}>();
const appStore = useAppStore();
const localStore = useLocalStore();
const keyEventStore = useKeyEventStore();
const channelInstancesStore = useChannelInstancesStore();
const { selectSessionId } = storeToRefs(channelInstancesStore);
const { isMultiSelectKey, isShiftKey } = storeToRefs(keyEventStore);
const { loadingText } = storeToRefs(appStore);
const { addDownloadTask, addUploadTask } = useDownloadStore();

const server = inject<ChannelInstance>(ChannelInstanceProvideKey)!;
const activeItem = inject<Ref<FileStoreItem>>(SftpActiveItemKey)!;
const selectedPaths = ref<Set<string>>(new Set()); // 选中项
const fileList = ref<FileStoreItem[]>([]); // 显示的文件项
const loadingItemFlags = ref<boolean>(false); // 加载文件列表状态
const renameItem = ref<FileStoreItem | null>(null); // 重命名项
const editName = ref(""); // 重命名，新建文件的名称
const uiActive = ref<boolean>(true); // 是否是UI激活状态
const sortState = reactive<{ key: ColKey; order: SortOrder }>({ key: "name", order: "asc" });
let resizeState: { key: ColKey; startX: number; startW: number } | null = null;
const editNameInputRef = ref<SystemInputExpose[] | null>(null);
const shiftKeyIndex = ref<number | null>(null);
const { on, emit } = useBus();
const closeFuns: UnlistenFn[] = [];
const copyData: { data: FileStoreItem[]; type: "copy" | "cut" } = { data: [], type: "copy" };

const tableWidthPx = computed(() => COL_KEYS.reduce((acc, k) => acc + colWidths[k], 0));
const serverId = computed(() => server.server.id);
const showRows = computed<FileStoreItem[]>(() => {
    const sign = sortState.order === "asc" ? 1 : -1;
    return [...fileList.value].sort((a, b) => {
        const primary = compareRows(a, b, sortState.key);
        if (primary !== 0) return primary * sign;
        return compareRows(a, b, "name");
    });
});

watch(activeItem, (newVal) => {
    selectedPaths.value = new Set();
    renameItem.value = null;
    loadFileItem(newVal);
    emit(ActiveFileEventKey, { sid: server.sessionId, path: newVal.id });
});

watch(renameItem, (newVal) => {
    if (newVal) {
        nextTick(() => {
            const el = editNameInputRef.value?.[0];
            console.log("el", el);
            if (!el) return;
            el.focus({ preventScroll: true });
            el.select();
        });
    }
});

function fileExtension(name: string): string {
    const lower = name.toLowerCase();
    const i = lower.lastIndexOf(".");
    if (i <= 0 || i === lower.length - 1) return "";
    return lower.slice(i + 1);
}

function fileIconByName(name: string): string {
    return FILE_EXT_ICONS[fileExtension(name)] ?? "mdi:file-outline";
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

function isEditableTextFile(row: FileStoreItem): boolean {
    return !row.isDir && !NON_EDITABLE_EXTS.has(fileExtension(baseName(row.id)));
}

function compareNullableNumber(a: number | null, b: number | null): number {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a - b;
}

function compareRows(a: FileStoreItem, b: FileStoreItem, key: ColKey): number {
    switch (key) {
        case "name": {
            const an = (a.isDir ? "d_" : "f_") + baseName(a.id);
            const bn = (b.isDir ? "d_" : "f_") + baseName(b.id);
            return compareNameLikeExplorer(an, bn);
        }
        case "size":
            return compareNullableNumber(a.size, b.size);
        case "type":
            return a.isDir ? 1 : -1;
        case "mtime":
            return compareNullableNumber(a.updatedAt, b.updatedAt);
        default:
            return 0;
    }
}

function onResizeMove(e: MouseEvent) {
    if (!resizeState) return;
    const dx = e.clientX - resizeState.startX;
    colWidths[resizeState.key] = Math.max(COL_MIN[resizeState.key], resizeState.startW + dx);
}

function stopResize() {
    resizeState = null;
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", stopResize);
}

function startResize(key: ColKey, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeState = { key, startX: e.clientX, startW: colWidths[key] };
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", stopResize);
}

function toggleSort(key: ColKey) {
    if (sortState.key === key) {
        sortState.order = sortState.order === "asc" ? "desc" : "asc";
    } else {
        sortState.key = key;
        sortState.order = "asc";
    }
}

function isSortActive(key: ColKey): boolean {
    return sortState.key === key;
}
function sortIndicator(key: ColKey): string {
    if (!isSortActive(key)) return "↕";
    return sortState.order === "asc" ? "↑" : "↓";
}

function rowNameIcon(row: FileStoreItem): string {
    if (row.isDir) return row.children !== null ? "mdi:folder" : "mdi:folder-outline";
    return fileIconByName(baseName(row.id));
}

async function moveFiles(moveItems: FileStoreItem[], dirItem: FileStoreItem, cut: boolean = false) {
    if (moveItems.length === 0) return;
    // 移动之前弹窗确定下 避免移动错误
    const ok = await showConfirm({
        title: cut ? "确认剪切文件吗？" : "确认复制文件吗？",
        message: buildMoveConfirmMessage(moveItems, dirItem.id),
        danger: true,
    });
    if (!ok) return;
    for (const moveItem of moveItems) {
        const newPath = await remoteJoin(dirItem.id, baseName(moveItem.id));
        if (cut) {
            await remoteMove(serverId.value, moveItem.id, newPath);
            fileList.value.remove(moveItem);
        } else {
            await remoteCopy(serverId.value, moveItem.id, newPath);
        }
    }
    loadDirectory(serverId.value, dirItem, true);
}

// 文件更新
async function fileChange(id: string) {
    let changeItem: FileStoreItem | null = null;
    treeForEach(props.rootFile, (item: FileStoreItem) => {
        if (item.id === id) {
            changeItem = item;
            return true;
        }
        return false;
    });
    if (!changeItem) return;
    changeItem = changeItem as FileStoreItem;
    const newItem = await oneFileRemoteItem(serverId.value, changeItem.linkPath || changeItem.id);
    if (newItem) {
        changeItem.size = newItem.size;
        changeItem.updatedAt = newItem.updatedAt;
    }
}

async function handleOpen(items: FileStoreItem[]) {
    if (items.length === 1) {
        const node = items[0];
        if (node.isDir) {
            await loadFileItem(node);
            return;
        }
    }
    // size 为 0 是合法空文件，不能用 truthy 判断过滤；只有目录或未知大小才不进入编辑器。
    items = items.filter((item) => !item.isDir && item.size !== null);
    if (!items.length) return;
    if (items.some((item) => item.size! > MAX_OPEN_SIZE)) {
        showToast("文件大小超过1MB，无法打开", "warning");
        return;
    }
    openOrFocusMonacoEditorWindow(
        items.map((item) => ({
            sessionId: server.sessionId,
            serverId: serverId.value,
            path: item.id,
            linkPath: item.linkPath,
            from: getCurrentWindow().label,
        })),
    );
}

async function handleDelete(items: FileStoreItem[]) {
    if (!items.length) return;
    const ok = await showConfirm({
        title: "确认删除",
        message: buildDeleteConfirmMessage(items),
        danger: true,
    });
    if (!ok) return;
    for (const node of items) {
        await deleteFileItem(serverId.value, node).catch((e) => {
            console.error(e);
            showToast("删除失败", "error");
        });
    }
}

async function confirmAddName(name: string, isDir: boolean = true) {
    const newName = name.trim();
    if (!newName) {
        return;
    }
    if (!checkLinuxFileName(newName)) {
        showToast("文件名不符合 Linux 文件系统命名规则", "error");
        return;
    }
    await addFileItem(serverId.value, activeItem.value, newName, isDir);
    fileList.value = activeItem.value.children ?? [];
}

function clickDownload(items: FileStoreItem[]) {
    loadingText.value = "下载任务生成中...";
    const promise = addDownloadTask(
        { sessionId: server.sessionId, serverId: serverId.value },
        items.map((v) => v.id),
    );
    promise
        .catch((e) => {
            console.error(e);
            showToast("下载任务生成失败", "error");
        })
        .finally(() => {
            loadingText.value = "";
        });
}

async function clickUpload(row: FileStoreItem, directory: boolean = true) {
    const uploadDefaultPath = await appStore.homeDir;
    if (appStore.osType === "macos") {
        const paths = await invoke<string[]>("pick_file_or_folder", { title: "上传", multiple: true, defaultPath: uploadDefaultPath });
        if (!paths) return;
        uploadFiles(paths, row);
        return;
    }
    const paths = await open({
        title: "上传",
        multiple: true,
        directory,
        defaultPath: uploadDefaultPath,
    });
    if (!paths) return;
    uploadFiles(paths, row);
}

function uploadFiles(paths: string[], fileItem: RemoteFileItem = activeItem.value) {
    const dirItem = fileItem.isDir ? fileItem : fileItem.parent;
    if (!dirItem || !dirItem.isDir) {
        showToast("请选择上传文件夹", "error");
        return;
    }
    const remoteDir = dirItem.linkPath || dirItem.id;
    const bakActiveItem = activeItem.value;
    addUploadTask({ sessionId: server.sessionId, serverId: serverId.value }, paths, remoteDir, () => {
        if (bakActiveItem === activeItem.value) {
            activeItem.value = dirItem;
        }
        loadFileItem(dirItem, true);
    });
}

async function openRowContextMenu(e: MouseEvent, row: FileStoreItem) {
    e.preventDefault();
    e.stopPropagation();
    const offline = server.status !== "connected";
    const onlyOne = selectedPaths.value.size < 2; // 之前只选了一个或者没选
    if (onlyOne) {
        // 之前只选了一个后 右键后只选择当前行
        selectedPaths.value = new Set([row.id]); // 右键后只选择当前行
    }
    const selectedItems = fileList.value.filter((item) => selectedPaths.value.has(item.id));
    const canBulkEdit = selectedItems.every((item) => isEditableTextFile(item));

    /* 使用系统关联软件打开文件 */
    async function openFileWithSystem(path: string, appPath: string | null): Promise<void> {
        if (!appPath) return;
        await invoke("open_file_with_app", {
            appPath,
            filePath: path,
        });
    }
    const haveSelectedApp = (await localStore.readCache<string[]>("SELECTED_OPEN_APP")) || [];
    async function selectLocalApp(): Promise<string | null> {
        const osType = appStore.osType;
        const defaultAppDir = osType === "macos" ? "/Applications" : osType === "windows" ? "C:\\Program Files" : undefined;
        const appPath = await open({
            title: "选择打开方式",
            multiple: false,
            defaultPath: defaultAppDir,
        });
        if (appPath) {
            haveSelectedApp?.remove(appPath);
            haveSelectedApp?.unshift(appPath);
            await localStore.writeCache("SELECTED_OPEN_APP", haveSelectedApp);
        }
        return appPath;
    }

    async function openFileByLocal(appPath?: string) {
        const item = selectedItems[0]!;
        // null 表示没有拿到文件大小，0 表示真实空文件；空文件也允许用系统应用打开。
        if (item.size === null) return;
        if (item.size > MAX_OPEN_SIZE) {
            showToast("文件大小超过1MB，无法打开", "warning");
            return;
        }
        const uid = uuid();
        const dir = await join(await localStore.tempRootDir, uid);
        const file = await join(dir, baseName(item.id));
        await mkdir(dir, { recursive: true });
        async function openAndWatchLocalFile() {
            // 系统应用编辑是通过临时文件中转，轮询 mtime 后再上传回远端。
            const statInfo = await stat(file);
            let mtime = statInfo.mtime;
            let count = 0;

            const task = async () => {
                // 只监听10分钟 或者 UI不激活
                if (count++ > 2 * 60 * 10 || !uiActive.value) return;
                const statInfo = await stat(file);
                if (mtime?.getTime() !== statInfo.mtime?.getTime()) {
                    await writeLocalFileToRemote(serverId.value, item.id, file, (process) => {
                        emit(SftpProcessEventKey, process);
                    });
                    fileChange(item.id);
                    mtime = statInfo.mtime;
                }
                setTimeout(() => {
                    task();
                }, 500);
            };
            openFileWithSystem(file, appPath ?? (await selectLocalApp()))
                .then(() => {
                    task();
                })
                .catch((e) => {
                    console.error(e);
                });
        }
        if (item.size === 0) {
            // 空文件没有下载 chunk，先创建本地空文件，再进入和普通文件一致的打开/监听流程。
            await writeFile(file, new Uint8Array(), { create: true });
            await openAndWatchLocalFile();
            loadingText.value = "";
            return;
        }
        let getSize = 0;
        sftpReadFileStream(serverId.value, item.id, 0, (chunk) => {
            writeFile(file, chunk, { append: true, create: true });
            getSize += chunk.length;
            const process = (getSize / item.size!) * 100;
            emit(SftpProcessEventKey, process);
        })
            .then(async () => {
                await openAndWatchLocalFile();
            })
            .finally(() => {
                loadingText.value = "";
            });
    }
    const menus: MenuItem[] = [
        {
            label: "打开",
            disabled: offline || !canBulkEdit,
            handler: () => {
                void handleOpen(selectedItems);
            },
        },
        {
            label: "打开方式",
            disabled: offline || !canBulkEdit,
            children: [
                {
                    label: "文本编辑器",
                    disabled: !canBulkEdit,
                    handler: () => {
                        void handleOpen(selectedItems);
                    },
                },
                {
                    label: "系统关联软件打开",
                    disabled: !canBulkEdit || !onlyOne,
                    handler: () => {
                        openFileByLocal();
                    },
                },
                ...(haveSelectedApp.length === 0
                    ? []
                    : ([
                          "---",
                          ...(await Promise.all(
                              haveSelectedApp.map(async (appPath) => {
                                  const name = await basename(appPath);
                                  const ext = await extname(appPath);
                                  const appImage = await invoke<string>("get_app_icon", { appPath });
                                  const label = ext ? name.replace(`.${ext}`, "") : name;
                                  return {
                                      label,
                                      image: appImage,
                                      disabled: !canBulkEdit,
                                      handler: () => {
                                          openFileByLocal(appPath);
                                      },
                                  };
                              }),
                          )),
                      ] as MenuItem[])),
            ],
        },
        {
            label: "刷新",
            disabled: offline,
            handler: () => emit(RefreshFileListEventKey),
        },
        "---",
        {
            label: "新建",
            disabled: offline,
            children: [
                {
                    label: "文件夹",
                    handler: async () => {
                        const value = await showPrompt({
                            title: "新建文件夹",
                            placeholder: "请输入文件夹名称",
                            confirmText: "创建",
                            cancelText: "取消",
                        });
                        if (value === null) return;
                        await confirmAddName(value);
                    },
                },
                {
                    label: "文件",
                    handler: async () => {
                        const value = await showPrompt({
                            title: "新建文件",
                            placeholder: "请输入文件名称",
                            confirmText: "创建",
                            cancelText: "取消",
                        });
                        if (value === null) return;
                        await confirmAddName(value, false);
                    },
                },
            ],
        },
        {
            label: "重命名",
            disabled: offline || selectedItems.length !== 1,
            handler: () => {
                renameItem.value = row;
                editName.value = baseName(row.id);
            },
        },
        {
            label: "快速删除(rm命令)",
            disabled: offline,
            handler: () => {
                void handleDelete(selectedItems);
            },
        },
        "---",
        {
            label: "复制路径",
            handler: () => {
                const text = selectedItems.length > 1 ? selectedItems.map((v) => v.id).join("\n") : (selectedItems[0]?.id ?? row.id);
                void copyText(text);
            },
        },
        "---",
        {
            label: "下载",
            disabled: offline,
            handler: () => {
                clickDownload(selectedItems);
            },
        },
        appStore.osType === "macos"
            ? {
                  label: "上传",
                  disabled: offline,
                  handler: async () => {
                      clickUpload(onlyOne ? row : activeItem.value);
                  },
              }
            : {
                  label: "上传",
                  disabled: offline,
                  children: [
                      {
                          label: "上传文件",
                          handler: async () => {
                              clickUpload(onlyOne ? row : activeItem.value, false);
                          },
                      },
                      {
                          label: "上传文件夹",
                          handler: async () => {
                              clickUpload(onlyOne ? row : activeItem.value);
                          },
                      },
                  ],
              },
        "---",
        {
            label: "文件权限…",
            disabled: offline || selectedItems.length !== 1,
            handler: async () => {
                const node = selectedItems[0]!;
                const perms = await showPermissionEditor({
                    title: "修改文件权限",
                    path: node.id,
                    defaultValue: node.permissions,
                    confirmText: "确定",
                    cancelText: "取消",
                });
                if (perms === null) return;
                await changeFileItemPermissions(serverId.value, node, perms).catch((e) => {
                    console.error(e);
                    showToast("文件权限修改失败", "error");
                });
            },
        },
    ];
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
}

async function loadFileItem(parent: FileStoreItem, force: boolean = false) {
    loadingItemFlags.value = !force;
    await loadDirectory(serverId.value, parent, force);
    fileList.value = parent.children ?? [];
    activeItem.value = parent;
    loadingItemFlags.value = false;
}

async function directLoadPath(path: string) {
    loadingItemFlags.value = true;
    const findParentFile = async (path: string): Promise<FileStoreItem> => {
        const parentPaths = pathAllParentPaths(path);
        let parent: FileStoreItem | null = null;
        for (let i = 0; i < parentPaths.length; i++) {
            const parentPath = parentPaths[i];
            if (parentPath === props.rootFile.id) {
                parent = props.rootFile;
            } else {
                parent = parent!.children!.find((item) => item.id === parentPath) as FileStoreItem;
            }
            if (parent.id === path) {
                return parent;
            }
            // 父路径未加载
            if (parent.children === null) {
                parent.loading = true;
                const children = await listRemoteSubFiles(serverId.value, parent.id);
                parent.children = children;
                parent.children.forEach((item) => {
                    item.level = parent!.level + 1;
                    item.parent = parent;
                });
                parent.loading = false;
            }
        }
        throw new Error("文件不存在");
    };
    const loadFiles = async (): Promise<FileStoreItem[] | null> => {
        // 先检查路径是否加载过
        const haveLoad = treeForEach(props.rootFile, (item: FileStoreItem) => {
            if (item.id === path) {
                return item.children !== null;
            }
            return false;
        });
        if (haveLoad) return null;
        return listRemoteSubFiles(serverId.value, path).then((files) => {
            fileList.value = files;
            return fileList.value;
        });
    };
    return Promise.all([findParentFile(path), loadFiles()])
        .then(([parent, files]) => {
            if (files) {
                parent.children = files;
                parent.children.forEach((item) => {
                    item.level = parent.level + 1;
                    item.parent = parent;
                });
                parent.leaf = parent.children.length === 0;
            }
            activeItem.value = parent;
        })
        .finally(() => {
            loadingItemFlags.value = false;
        });
}

function handleRowClick(row: FileStoreItem) {
    const index = showRows.value.indexOf(row);
    if (isShiftKey.value && shiftKeyIndex.value) {
        const ix = shiftKeyIndex.value;
        const up = ix > index;
        const down = ix < index;
        // 原先点击的位置是否是选择的
        const rowBeforeIsSelected = selectedPaths.value.has(row.id);
        if (down === up) return;
        const len = showRows.value.length;
        const delBefore = (index: number) => {
            for (let i = index - 1; i >= 0; i--) {
                const id = showRows.value[i].id;
                if (selectedPaths.value.has(id)) {
                    selectedPaths.value.delete(id);
                    continue;
                }
                break;
            }
        };
        const addAfter = (index: number) => {
            for (let i = index + 1; i < len; i++) {
                const id = showRows.value[i].id;
                if (selectedPaths.value.has(id)) {
                    selectedPaths.value.delete(id);
                    continue;
                }
                // 不是紧挨着的不管
                break;
            }
        };
        if (up) {
            // 先向后找按着的都移除
            addAfter(ix);
            // 先前选中到点击为止
            for (let i = ix; i >= index; i--) {
                const id = showRows.value[i].id;
                selectedPaths.value.add(id);
            }
            // 在点击位向前找紧挨着的移除
            // 原先位置是选中的前一个算是挨着选中的
            if (rowBeforeIsSelected) delBefore(index);
        } else if (down) {
            // 先向前找按着的都移除
            delBefore(ix);
            // 先后选中到点击为止
            for (let i = ix; i <= index; i++) {
                const id = showRows.value[i].id;
                selectedPaths.value.add(id);
            }
            // 在点击位向后找紧挨着的移除
            if (rowBeforeIsSelected) addAfter(index);
        } else {
            addAfter(ix);
            delBefore(ix);
        }
        return;
    }
    shiftKeyIndex.value = index;
    if (isMultiSelectKey.value) {
        if (selectedPaths.value.has(row.id)) {
            selectedPaths.value.delete(row.id);
        } else {
            selectedPaths.value.add(row.id);
        }
    } else {
        selectedPaths.value = new Set([row.id]);
    }
}

function autoScrollToRow(row: FileStoreItem) {
    const rowEl = tableWrapRef.value?.querySelector(`tr[data-id="${row.id}"]`);
    if (rowEl) {
        rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
}

function dblclickRow(row: FileStoreItem) {
    if (row.isDir) {
        activeItem.value = row;
    } else {
        handleOpen([row]);
    }
}

function inputKeyDown(e: KeyboardEvent) {
    const { key } = e;
    if (key === "Enter") {
        confirmName();
    } else if (key === "Escape") {
        renameItem.value = null;
    }
}
async function confirmName(blur: boolean = false) {
    if (!editName.value) {
        renameItem.value = null;
        return;
    }
    if (!checkLinuxFileName(editName.value)) {
        showToast("文件名不符合 Linux 文件系统命名规则", "error");
        if (blur) renameItem.value = null;
        return;
    }
    await changeFileItemName(serverId.value, renameItem.value!, editName.value);
    renameItem.value = null;
}

function updateColWidths() {
    const tableWidth = tableWrapRef.value?.getBoundingClientRect().width ?? 0;
    colWidths.name = tableWidth - colWidths.size - colWidths.type - colWidths.mtime - colWidths.perm - colWidths.owner;
}

// 快捷键部分
const handleTableKeyDowns: KeyEventCallback[] = [
    // 快捷删除
    (e) => {
        if (e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) {
            void handleDelete(
                Array.from(selectedPaths.value)
                    .map((v) => fileList.value.find((item) => item.id === v))
                    .filter((v) => v) as FileStoreItem[],
            );
            return true;
        }
        return false;
    },
    // 上下键
    ({ key }) => {
        if (!isShiftKey.value) return false;
        if (key !== "ArrowUp" && key !== "ArrowDown") return false;
        if (!shiftKeyIndex.value) return false;
        if (selectedPaths.value.size === 0) return false;
        const indexs = Array.from(selectedPaths.value).map((v) => showRows.value.findIndex((item) => item.id === v));
        const startIndex = shiftKeyIndex.value;
        const up = indexs.includes(startIndex - 1);
        const down = indexs.includes(startIndex + 1);
        let _si: number = startIndex;
        let _ei: number = startIndex;
        for (let i = startIndex; i >= 0 && i < showRows.value.length; i = up ? i - 1 : i + 1) {
            if (indexs.includes(i)) continue;
            if (up) {
                _si = i + 1;
                _ei = startIndex;
            } else {
                _si = startIndex;
                _ei = i - 1;
            }
            break;
        }
        let indexIndex = 0;
        let remove = false;
        if (key === "ArrowUp") {
            // up === down 表示只选了开始一个
            if (up || up === down) {
                _si = Math.max(0, _si - 1);
                indexIndex = _si;
            } else {
                // 移除之前的_ei的选中
                indexIndex = _ei;
                remove = true;
            }
        } else {
            if (down || up === down) {
                _ei = Math.min(showRows.value.length - 1, _ei + 1);
                indexIndex = _ei;
            } else {
                // 移除之前的_si的选中
                indexIndex = _si;
                remove = true;
            }
        }
        const item = showRows.value[indexIndex];
        if (remove) {
            selectedPaths.value.delete(item.id);
        } else {
            handleRowClick(item);
        }
        autoScrollToRow(item);
        return true;
    },
    // 单选模式下
    (e) => {
        const key = e.key;
        if (isMultiSelectKey.value) return false;
        let oneSelect: FileStoreItem | null = null;
        if (selectedPaths.value.size === 1 && renameItem.value === null) {
            oneSelect = fileList.value.find((item) => selectedPaths.value.has(item.id)) || null;
        }
        if (!oneSelect) return false;
        if (key === "Enter") {
            renameItem.value = oneSelect;
            editName.value = baseName(renameItem.value!.id);
            return true;
        } else if (key === "ArrowUp" || key === "ArrowDown") {
            const index = showRows.value.indexOf(oneSelect);
            let newIndex = key === "ArrowUp" ? index - 1 : index + 1;
            if (newIndex < 0) {
                newIndex = showRows.value.length - 1;
            } else if (newIndex >= showRows.value.length) {
                newIndex = 0;
            }
            const item = showRows.value[newIndex];
            handleRowClick(item);
            autoScrollToRow(item);
            return true;
        } else if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
            const index = showRows.value.indexOf(oneSelect);
            let second = false;
            for (let i = index + 1; i < showRows.value.length; i++) {
                const item = showRows.value[i];
                const name = baseName(item.id);
                if (name.startsWith(key)) {
                    handleRowClick(item);
                    autoScrollToRow(item);
                    return true;
                }
                if (!second && i === showRows.value.length - 1) {
                    // 最后一个了 重新开始0开始
                    i = -1; // 下一个就是0
                    second = true;
                }
            }
        }
        return false;
    },
    // 重命名模式下退出
    ({ key }) => {
        if (key === "Escape" && renameItem.value !== null) {
            renameItem.value = null;
            editName.value = "";
            tableWrapRef.value?.focus();
            return true;
        }
        return false;
    },
];
closeFuns.push(
    keyEventStore.register((e) => {
        if (!tableWrapRef.value?.contains(e.target as HTMLElement)) return false;
        return handleTableKeyDowns.some((fn) => fn(e));
    }),
);
onMounted(async () => {
    // 默认选择home
    if (activeItem.value.id === "/") {
        const remoteHome = await resolveRemoteHome(serverId.value);
        directLoadPath(remoteHome);
    } else {
        loadFileItem(activeItem.value);
    }
    // 监听直接远程路径事件
    closeFuns.push(
        on(DirectRemotePathEventKey, ({ sid, path }) => {
            if (sid !== server.sessionId) return;
            directLoadPath(path);
        }),
    );
    // 监听刷新文件列表事件
    closeFuns.push(
        on(RefreshFileListEventKey, () => {
            loadFileItem(activeItem.value, true);
        }),
    );
    // 监听下载菜单打开事件
    closeFuns.push(
        on(DownloadMenuOpenEventKey, () => {
            const items = fileList.value.filter((item) => selectedPaths.value.has(item.id));
            if (items.length === 0) return;
            clickDownload(items);
        }),
    );
    // 监听上传菜单打开事件
    closeFuns.push(
        on(UploadFileEventKey, () => {
            clickUpload(activeItem.value);
        }),
    );
    // 更新列宽
    updateColWidths();
    // 监听窗口大小变化事件
    window.addEventListener("resize", updateColWidths);
    // 监听服务器快照事件
    server.snapshotFn.sftpFileTable = () => {
        return {
            fileTableScrollTop: tableWrapRef.value?.scrollTop,
            selectedPaths: Array.from(selectedPaths.value),
        } as TermSnapshot;
    };
    // 恢复服务器快照
    nextTick(() => {
        if (server.snapshot.sftpFileTable) {
            const snapshot = server.snapshot.sftpFileTable as TermSnapshot;
            delete server.snapshot.sftpFileTable;
            tableWrapRef.value!.scrollTop = snapshot.fileTableScrollTop;
            selectedPaths.value = new Set(snapshot.selectedPaths);
        }
    });
    getCurrentWindow().listen<MonacoEditorSavedPayload>(MONACO_EDITOR_SAVED_EVENT, ({ payload }) => {
        if (payload.sessionId !== server.sessionId) return;
        fileChange(payload.path);
    });
});

onUnmounted(() => {
    stopResize();
    uiActive.value = false;
    closeFuns.forEach((unlisten) => unlisten());
});

function dragLocalFile(payload: DragDropEvent) {
    if (payload.type !== "drop") return;
    let { x, y } = payload.position;
    if (appStore.osType === "windows") {
        x = x / appStore.scaleFactor;
        y = y / appStore.scaleFactor;
    }
    // 获取tableWrapRef的x,y,endx,endy
    const tableWrapRect = tableWrapRef.value!.getBoundingClientRect();
    const tableWrapX = tableWrapRect.left;
    const tableWrapY = tableWrapRect.top;
    const tableWrapEndX = tableWrapX + tableWrapRect.width;
    const tableWrapEndY = tableWrapY + tableWrapRect.height;
    if (x < tableWrapX || x > tableWrapEndX || y < tableWrapY || y > tableWrapEndY) return;
    if (payload.paths.length === 0) return;
    uploadFiles(payload.paths);
}

// 将窗口拖回来

getCurrentWindow()
    .onDragDropEvent(({ payload }) => {
        // 不是当前激活的sessionId 不处理拖拽
        if (selectSessionId.value !== server.sessionId) return;
        if (payload.type !== "drop" || payload.paths.length === 0) return;
        dragLocalFile(payload);
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });

dragListener(() => {
    const table = tableWrapRef.value;
    return Array.from(table?.querySelectorAll(".data-row") ?? []);
}).then((unlisten) => {
    closeFuns.push(unlisten);
});

let fileTableDrag = false;
function dragstart() {
    fileTableDrag = true;
    const items = Array.from(selectedPaths.value)
        .map((v) => fileList.value.find((item) => item.id === v))
        .filter((v) => v) as FileStoreItem[];
    if (items.length === 0) return;
    emit(FileDragStartEventKey, items);
}

function dragend() {
    // dragend先于drop执行 延迟60ms
    setTimeout(() => {
        fileTableDrag = false;
        emit(FileDragEndEventKey);
    }, 60);
}

function dragover(event: DragEvent) {
    if (!fileTableDrag) return;
    const target = event.target as HTMLElement;
    const isDir = target.getAttribute("data-is-dir") === "true";
    if (!isDir) return;
    target.classList.add("drag-over");
}
function dragleave(event: DragEvent) {
    if (!fileTableDrag) return;
    const target = event.target as HTMLElement;
    target.classList.remove("drag-over");
}
async function drop(event: DragEvent) {
    if (!fileTableDrag) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    target.classList.remove("drag-over");
    const isDir = target.getAttribute("data-is-dir") === "true";
    if (!isDir) return;
    const id = target.getAttribute("data-id");
    const dirItem = fileList.value.find((item) => item.id === id);
    if (!dirItem) return;
    const selectedItems = Array.from(selectedPaths.value)
        .filter((v) => v !== id)
        .map((v) => fileList.value.find((item) => item.id === v))
        .filter((v) => v) as FileStoreItem[];
    moveFiles(selectedItems, dirItem, true);
}
</script>

<template>
    <div class="table-wrap grow min-w-0 overflow-auto" ref="tableWrapRef" tabindex="0">
        <table class="file-table text-left" :style="{ width: tableWidthPx + 'px' }">
            <colgroup>
                <col class="col-name" :style="{ width: colWidths.name + 'px' }" />
                <col class="col-size" :style="{ width: colWidths.size + 'px' }" />
                <col class="col-type" :style="{ width: colWidths.type + 'px' }" />
                <col class="col-mtime" :style="{ width: colWidths.mtime + 'px' }" />
                <col class="col-perm" :style="{ width: colWidths.perm + 'px' }" />
                <col class="col-owner" :style="{ width: colWidths.owner + 'px' }" />
            </colgroup>
            <thead>
                <tr>
                    <th
                        v-for="col in [
                            { key: 'name', label: '文件名' },
                            { key: 'size', label: '大小' },
                            { key: 'type', label: '类型' },
                            { key: 'mtime', label: '修改时间' },
                            { key: 'perm', label: '权限' },
                            { key: 'owner', label: '用户/组' },
                        ] as const"
                        :key="col.key"
                        class="th-resizable th-sortable"
                        @click="toggleSort(col.key)"
                    >
                        <div class="flex items-center">
                            <span class="th-label">{{ col.label }}</span>
                            <span class="th-sort-ind" :class="{ active: isSortActive(col.key) }">{{ sortIndicator(col.key) }}</span>
                        </div>
                        <span class="col-resize-handle" title="拖动调整列宽" @mousedown="startResize(col.key, $event)" />
                    </th>
                </tr>
            </thead>
            <tbody v-if="loadingItemFlags || showRows.length === 0">
                <tr v-if="loadingItemFlags">
                    <td colspan="6" class="px-3 py-6 text-center text-white/50 h-[100px]">加载中…</td>
                </tr>
                <tr v-else-if="showRows.length === 0">
                    <td colspan="6" class="px-3 py-6 text-center text-white/50 h-[100px]">暂无数据</td>
                </tr>
            </tbody>
            <tbody v-else>
                <tr
                    v-for="row in showRows"
                    :key="row.id"
                    :data-id="row.id"
                    :data-is-dir="row.isDir"
                    class="data-row"
                    :class="{ sel: selectedPaths.has(row.id) }"
                    draggable="true"
                    @dblclick.prevent.stop="dblclickRow(row)"
                    @contextmenu="openRowContextMenu($event, row)"
                    @click="handleRowClick(row)"
                    @dragstart="dragstart"
                    @dragend="dragend"
                    @dragover="dragover"
                    @dragleave="dragleave"
                    @drop="drop"
                >
                    <td class="cell-name">
                        <template v-if="renameItem !== row">
                            <span class="name-cell-inner">
                                <span class="icon-stack text-base shrink-0">
                                    <Icon :icon="rowNameIcon(row)" class="icon-stack-main name-cell-ic" :class="{ 'icon-file-icon': !row.isDir }" />
                                    <Icon v-if="row.linkPath" icon="ion:arrow-redo" class="lnk-corner-ic" aria-hidden="true" />
                                </span>
                                <span class="name-text">{{ baseName(row.id) }}</span>
                            </span>
                        </template>
                        <template v-else>
                            <span class="name-cell-inner">
                                <span class="icon-stack text-base shrink-0">
                                    <Icon :icon="rowNameIcon(row)" class="icon-stack-main name-cell-ic" :class="{ 'icon-file-icon': !row.isDir }" />
                                    <Icon v-if="row.linkPath" icon="ion:arrow-redo" class="icon-link-icon" aria-hidden="true" />
                                </span>
                                <SystemInput v-model="editName" ref="editNameInputRef" class="table-inline-input" @blur="confirmName(true)" @keydown.stop="inputKeyDown" @click.stop />
                            </span>
                        </template>
                    </td>
                    <td class="cell-numeric">{{ row.size !== null ? formatAdaptiveBytes(row.size) : "" }}</td>
                    <td>{{ row.isDir ? "文件夹" : fileExtension(baseName(row.id)) }}</td>
                    <td class="cell-mtime">{{ row.updatedAt ? dayjs(new Date(row.updatedAt * 1000)).format("YYYY/MM/DD HH:mm") : "" }}</td>
                    <td class="cell-perm font-mono text-xs">{{ formatPermissionSymbolic(row) }}</td>
                    <td class="cell-owner text-xs">{{ row.owner }}/{{ row.group }}</td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style scoped lang="scss">
.file-table {
    border-collapse: collapse;
    table-layout: fixed;

    .col-name {
        min-width: 0;
    }

    th,
    td {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: middle;
    }

    th {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 4px 6px;
        font-weight: 600;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .th-resizable {
        position: relative;
        padding-right: 14px;
    }

    .th-label {
        display: inline-block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .th-sortable {
        cursor: pointer;
        user-select: none;
    }

    .th-sort-ind {
        margin-left: 4px;
        font-size: var(--font-size-xs);
        vertical-align: 1px;
    }

    .col-resize-handle {
        position: absolute;
        top: 0;
        right: 0;
        width: 8px;
        height: 100%;
        cursor: col-resize;
        user-select: none;
        touch-action: none;
        z-index: 2;

        &::after {
            content: "";
            position: absolute;
            top: 20%;
            bottom: 20%;
            right: 3px;
            width: 1px;
        }

        &:hover::after {
        }
    }

    td {
        padding: 4px 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .cell-name {
        overflow: hidden;
    }
    .cell-mtime {
        font-variant-numeric: tabular-nums;
    }

    .name-cell-inner {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
    }

    .icon-stack {
        position: relative;
        width: 1.125rem;
        height: 1.125rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.95;
    }

    .icon-stack-main {
        width: 1.125rem;
        height: 1.125rem;
    }

    .lnk-corner-ic {
        position: absolute;
        left: 0px;
        bottom: 1px;
        width: 0.55rem;
        height: 0.55rem;
        filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.85));
        pointer-events: none;
    }

    .name-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .table-inline-input {
        width: 100%;
        min-width: 0;
        border-radius: 4px;
        color: inherit;
        line-height: 1.2;
        padding: 2px 6px;
        outline: none;
    }

    .cell-numeric {
        text-align: right;
        font-variant-numeric: tabular-nums;
    }
}

.data-row {
    cursor: default;
    user-select: none;
}
</style>
