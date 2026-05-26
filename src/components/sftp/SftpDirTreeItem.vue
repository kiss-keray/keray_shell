<script setup lang="tsx">
import { buildMoveConfirmMessage } from "@/utils/confirmMessage";
import { ChannelInstanceProvideKey, CustomMenusEventKey, SftpActiveItemKey } from "@/utils/constant";
import { addFileItem, changeFileItemName, changeFileItemPermissions, deleteFileItem, loadDirectory, type FileStoreItem } from ".";
import { showPermissionEditor } from "./ui";
import useBus, { FileDragEndEventKey, FileDragStartEventKey, RefreshFileListEventKey } from "@/composables/useBus";
import { baseName, checkLinuxFileName } from "@/utils/fsUtil";
import { useKeyEventStore } from "@/stores/keyEvent";
import { open } from "@tauri-apps/plugin-dialog";
import { storeToRefs } from "pinia";
import type { MenuItem } from "../DefaultMenuItems.vue";

const props = defineProps<{
    fileItem: FileStoreItem;
    treeRootRef: HTMLDivElement;
}>();
const appStore = useAppStore();
const { emit, on, off } = useBus();
const { addDownloadTask, addUploadTask } = useDownloadStore();
const { loadingText } = storeToRefs(appStore);

const server = inject<ChannelInstance>(ChannelInstanceProvideKey)!;
const activeItem = inject<Ref<FileStoreItem>>(SftpActiveItemKey)!;
const editName = ref<string | null>(null);
const rowRef = ref<HTMLDivElement>();
const editNameInputRef = ref<HTMLInputElement | null>(null);

const leaf = computed(() => {
    if (props.fileItem.children === null) return false;
    return props.fileItem.children.filter((v) => v.isDir).length === 0;
});

watch(activeItem, (newVal) => {
    // 如果activeItem不是当前item，则不处理
    if (newVal !== props.fileItem) {
        return;
    }
    autoScrollToActive(newVal);

    watch(editName, (newVal) => {
        if (newVal) {
            nextTick(() => {
                const el = editNameInputRef.value;
                if (!el) return;
                el.focus({ preventScroll: true });
                el.select();
            });
        }
    });
});

function autoScrollToActive(newVal: FileStoreItem) {
    // 将所有上级open并且每一级的文件夹
    let rootFile = newVal;
    for (let parent: FileStoreItem | null = newVal; parent; parent = parent.parent) {
        if (parent !== newVal) parent.open = true; // 激活的item不自动展开
        rootFile = parent!;
    }
    let count = 0; // 计算当前active前面显示了多少行  根节点算1
    treeForEach<FileStoreItem>(
        rootFile,
        (item: FileStoreItem, _, list?: FileStoreItem[]) => {
            if (!item.isDir) return false; // 不是文件夹不计算
            if (!list) return false; // 没有兄弟节点，说明是根节点
            count++;
            return item === newVal;
        },
        (item: FileStoreItem): FileStoreItem[] => {
            if (!item.open) return [];
            const children = item.children ?? [];
            return children;
        },
    );
    const rowHeight = rowRef.value?.getBoundingClientRect().height || 26;
    const itemTop = count * rowHeight;
    // 检查itemTop是否在props.treeRootRef视窗内
    nextTick(() => {
        if (itemTop < props.treeRootRef.scrollTop) {
            props.treeRootRef.scrollTop = itemTop - rowHeight;
        } else if (itemTop + rowHeight > props.treeRootRef.scrollTop + props.treeRootRef.clientHeight) {
            props.treeRootRef.scrollTop = itemTop - props.treeRootRef.clientHeight + rowHeight * 2;
        }
    });
}

function uploadFiles(paths: string[], fileItem: RemoteFileItem) {
    if (!fileItem.isDir) {
        showToast("请选择上传文件夹", "error");
        return;
    }
    const remoteDir = fileItem.linkPath || fileItem.id;
    const bakActiveItem = activeItem.value;
    addUploadTask({ sessionId: server.sessionId, serverId: server.server.id }, paths, remoteDir, () => {
        if (bakActiveItem === activeItem.value) {
            activeItem.value = fileItem;
        }
        emit(RefreshFileListEventKey);
    });
}

async function openContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const offline = server.status !== "connected";
    const node = props.fileItem;
    const isRoot = node.id === "/";
    const isMultiSelect = false;
    const uploadDefaultPath = await appStore.homeDir;
    const menus: MenuItem[] = [
        { label: "刷新", disabled: offline || isMultiSelect, handler: () => emit(RefreshFileListEventKey) },
        "---",
        {
            label: "新建文件夹",
            disabled: offline || isMultiSelect,
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
            label: "重命名",
            disabled: offline || isRoot || isMultiSelect,
            handler: () => {
                editName.value = baseName(node.id);
            },
        },
        {
            label: "快速删除(rm命令)",
            disabled: offline || isRoot || isMultiSelect,
            handler: async () => {
                const ok = await showConfirm({
                    title: "确认删除",
                    message: "确定要删除该文件吗？",
                    danger: true,
                });
                if (!ok) return;
                for (let p: FileStoreItem | null = activeItem.value; p; p = p.parent) {
                    if (p === node) {
                        activeItem.value = node.parent!;
                        break;
                    }
                }
                deleteFileItem(server.server.id, node);
            },
        },
        "---",
        {
            label: "复制路径",
            disabled: isMultiSelect,
            handler: () => {
                void copyText(node.id);
            },
        },
        "---",
        {
            label: "下载",
            disabled: offline || isRoot,
            handler: () => {
                loadingText.value = "下载任务生成中...";
                const promise = addDownloadTask({ sessionId: server.sessionId, serverId: server.server.id }, [node.id]);
                promise
                    .catch((e) => {
                        console.error(e);
                        showToast("下载任务生成失败", "error");
                    })
                    .finally(() => {
                        loadingText.value = "";
                    });
            },
        },

        appStore.osType === "macos"
            ? {
                  label: "上传",
                  disabled: offline,
                  handler: async () => {
                      const paths = await invoke<string[]>("pick_file_or_folder", { title: "上传", multiple: true, defaultPath: uploadDefaultPath });
                      if (!paths) return;
                      uploadFiles(paths, node);
                  },
              }
            : {
                  label: "上传",
                  disabled: offline,
                  children: [
                      {
                          label: "上传文件",
                          handler: async () => {
                              const paths = await open({
                                  title: "上传",
                                  multiple: true,
                                  directory: false,
                                  defaultPath: uploadDefaultPath,
                              });
                              if (!paths) return;
                              uploadFiles(paths, node);
                          },
                      },
                      {
                          label: "上传文件夹",
                          handler: async () => {
                              const paths = await open({
                                  title: "上传",
                                  multiple: true,
                                  directory: true,
                                  defaultPath: uploadDefaultPath,
                              });
                              if (!paths) return;
                              uploadFiles(paths, node);
                          },
                      },
                  ],
              },
        "---",
        {
            label: "文件权限…",
            disabled: offline || isRoot || isMultiSelect,
            handler: async () => {
                const perms = await showPermissionEditor({
                    title: "修改文件权限",
                    path: node.id,
                    defaultValue: node.permissions,
                    confirmText: "确定",
                    cancelText: "取消",
                });
                if (perms === null) return;
                await changeFileItemPermissions(server.server.id, node, perms).catch((e) => {
                    console.error(e);
                    showToast("文件权限修改失败", "error");
                });
            },
        },
    ];
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
}

function clickItem() {
    activeItem.value = props.fileItem;
}

async function confirmName(blur: boolean = false) {
    if (!editName.value) {
        editName.value = null;
        return;
    }
    if (!checkLinuxFileName(editName.value)) {
        showToast("文件名不符合 Linux 文件系统命名规则", "error");
        if (blur) editName.value = null;
        return;
    }
    await changeFileItemName(server.server.id, props.fileItem, editName.value);
    editName.value = null;
}

async function confirmAddName(name: string) {
    const newName = name.trim();
    if (!newName) {
        return;
    }
    if (!checkLinuxFileName(newName)) {
        showToast("文件名不符合 Linux 文件系统命名规则", "error");
        return;
    }
    const id = await addFileItem(server.server.id, props.fileItem, newName);
    const newItem = props.fileItem.children?.find((v) => v.id === id);
    if (newItem) {
        activeItem.value = newItem;
    }
}
function handleTableKeyDown(e: KeyboardEvent) {
    if (props.fileItem.id === "/") return;
    const { key } = e;
    if (key === "Enter") {
        editName.value = baseName(props.fileItem.id);
    }
}

onUnmounted(() => {
    off(FileDragStartEventKey);
    off(FileDragEndEventKey);
});

on(FileDragStartEventKey, (items) => {
    dragItems.length = 0;
    dragItems.push(...items);
});
on(FileDragEndEventKey, () => {
    dragItems.length = 0;
});

const dragItems: FileStoreItem[] = [];

function dragover(e: DragEvent) {
    if (dragItems.length === 0) return;
    const target = e.target as HTMLElement;
    target.classList.add("drag-over");
}
function dragleave(e: DragEvent) {
    if (dragItems.length === 0) return;
    const target = e.target as HTMLElement;
    target.classList.remove("drag-over");
}
async function drop(e: DragEvent) {
    if (dragItems.length === 0) return;
    const target = e.target as HTMLElement;
    target.classList.remove("drag-over");
    const dirItem = props.fileItem;
    const fileList = activeItem.value.children!;
    // 移动之前弹窗确定下 避免移动错误
    const ok = await showConfirm({
        title: "确认移动",
        message: buildMoveConfirmMessage(dragItems, dirItem.id),
        danger: true,
    });
    if (!ok) return;
    for (const moveItem of dragItems) {
        const newPath = await remoteJoin(dirItem.id, baseName(moveItem.id));
        await remoteMove(server.server.id, moveItem.id, newPath);
        fileList.remove(moveItem);
    }
    loadDirectory(server.server.id, dirItem, true);
}
</script>

<template>
    <div class="tree-item-root" tabindex="0" @keydown.stop="handleTableKeyDown($event)">
        <div
            ref="rowRef"
            class="tree-row"
            :class="{ active: activeItem.id === fileItem.id }"
            :style="{ paddingLeft: `${8 + fileItem.level * 14}px` }"
            @click="clickItem"
            @dblclick="activeItem.open = !activeItem.open"
            @contextmenu="openContextMenu($event)"
            @dragover="dragover"
            @dragleave="dragleave"
            @drop="drop"
        >
            <button type="button" class="tree-toggle" disabled>
                <Icon v-if="fileItem.loading" icon="mdi:loading" class="text-base opacity-80 spin" />
                <Icon
                    v-else-if="fileItem.children?.length && !leaf"
                    :icon="fileItem.open ? 'mdi:chevron-down' : 'mdi:chevron-right'"
                    class="text-base opacity-70"
                    @click="fileItem.open = !fileItem.open"
                />
            </button>
            <div class="tree-open min-w-0">
                <span class="folder-icon-stack">
                    <Icon :icon="fileItem.children ? 'mdi:folder' : 'mdi:folder-outline'" class="folder-ic folder-ic-main" />
                    <Icon v-if="fileItem.linkPath" icon="ion:arrow-redo" class="lnk-corner-ic" aria-hidden="true" />
                </span>
                <span v-if="editName === null" class="truncate">{{ baseName(fileItem.id) }}</span>
                <input v-else v-model="editName" ref="editNameInputRef" class="tree-inline-input" @blur="confirmName(true)" @keydown.enter="confirmName" @keydown.esc="editName = null" @click.stop />
            </div>
        </div>
        <div v-show="fileItem.open">
            <SftpDirTreeItem v-for="child in (fileItem.children ?? []).filter((v) => v.isDir)" :key="child.id" :file-item="child" :tree-root-ref="treeRootRef" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.tree-row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 8px;
    text-align: left;
    cursor: default;
}

.tree-toggle {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;

    &:disabled {
        cursor: default;
    }
    &:not(:disabled) {
        cursor: pointer;
    }
}

.tree-open {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 0;
    color: inherit;
    text-align: left;
}

.tree-inline-input {
    width: 100%;
    min-width: 0;
    border-radius: 4px;
    color: inherit;
    line-height: 1.2;
    padding: 2px 6px;
    outline: none;
}

.folder-icon-stack {
    position: relative;
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.95;
}

.folder-ic-main {
    width: 1.125rem;
    height: 1.125rem;
}

.folder-ic {
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

.spin {
    animation: sftp-spin 0.85s linear infinite;
}

@keyframes sftp-spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
