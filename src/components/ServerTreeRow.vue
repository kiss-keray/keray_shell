<script setup lang="ts">
import { storeToRefs } from "pinia";
import type { PrivateKeyModel, RowData, ServerGroupModel } from "@/stores/serverData";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { EDIT_SERVER_SAVED_EVENT, type EditServerSavedPayload, openOrFocusEditServerWindow } from "@/utils/window";
import dayjs from "dayjs";
import { CHANNEL_INSTANCE_GROUP_CREATE_EVENT, type ChannelInstanceGroupCreatePayload } from "@/stores/channelInstances";

const props = defineProps<{
    row: RowData;
    level: number;
    selectedRawData: Set<RowData>;
    expandedGroupIds: Set<string>;
    copyData: {
        type: "copy" | "cut";
        data: RowData[];
    };
    searchKeyword: string;
}>();
const serverDataStore = useServerDataStore();
const keyEventStore = useKeyEventStore();
const { serverRootGroup } = storeToRefs(serverDataStore);
const { isGroupModel, isRoot, isServerModel, serverDataChange, deleteServerRow, addServerGroup, findServerDataById, reloadServerData, exportServerData, importServerData } = serverDataStore;
const { isMultiSelectKey } = storeToRefs(keyEventStore);
const editName = ref<string | null>(null);
/** 内联重命名输入框（分组 / 服务器互斥渲染，同一 ref） */
const editNameInputRef = ref<HTMLInputElement | null>(null);
const closeFuns: UnlistenFn[] = [];
/** 是否显示 */
const show = computed(() => {
    if (props.searchKeyword.trim()) {
        if (isGroup.value) {
            return treeForEach<ServerGroupModel>(groupModel.value, (item: ServerGroupModel) => {
                if (item.servers?.some((sv) => match(sv))) {
                    return true;
                }
                return match(item);
            });
        } else {
            return match(props.row);
        }
    }
    return true;
});
/** 是否选中 */
const isSelected = computed(() => props.selectedRawData.has(props.row));
/** 是否只有当前一项 */
const onlySelectThis = computed(() => props.selectedRawData.size === 1 && isSelected.value);
/** 是否是分组 */
const isGroup = computed(() => isGroupModel(props.row));
/** 分组模型 */
const groupModel = computed(() => props.row as ServerGroupModel);
/** 服务器模型 */
const serverModel = computed(() => props.row as ServerDataModel);
/** 是否是剪切 */
const isCut = computed(() => props.copyData.type === "cut" && props.copyData.data.includes(props.row));
/** 是否展开 */
const isExpanded = computed(() => props.expandedGroupIds.has(groupModel.value.id));
/** 是否为空 */
const groupEmpty = computed(() => {
    return isGroup.value && groupModel.value.children.length === 0 && groupModel.value.servers.length === 0;
});
/** 路径 */
const path = computed(() => {
    const nf = (g: ServerGroupModel): string => {
        if (isRoot(g) || !g.parent) return "";
        return `${nf(g.parent!)}/${g.name}`;
    };
    if (isGroup.value) {
        return nf(groupModel.value);
    }
    return nf(serverModel.value.group!);
});
/** 预览时使用的子分组列表：先移除被拖动的顶层项，再按 moveData 的追加规则放到落点分组末尾。 */
const previewChildren = computed(() => {
    if (!isGroup.value) return [];
    const children = [...groupModel.value.children];
    children.sort((a, b) => a.order - b.order);
    return children;
});
/** 预览时使用的服务器列表：与 previewChildren 保持同一套最终落点规则。 */
const previewServers = computed(() => {
    if (!isGroup.value) return [];
    const servers = [...groupModel.value.servers];
    servers.sort((a, b) => a.order - b.order);
    return servers;
});
/** 按树结构顺序收集当前选中的服务器（用于右键「连接选中」等）。 */
const selectedServers = computed<ServerDataModel[]>(() => {
    const servers: Set<ServerDataModel> = new Set();
    props.selectedRawData.forEach((item) => {
        if (isServerModel(item)) {
            servers.add(item);
        } else if (isGroupModel(item)) {
            treeForEach<ServerGroupModel>(item, (item: ServerGroupModel) => {
                item.servers.forEach((server) => {
                    servers.add(server);
                });
            });
        }
    });
    return Array.from(servers);
});

/** 服务器数量 */
const serverCount = computed(() => {
    if (isGroup.value) {
        let count = 0;
        treeForEach<ServerGroupModel>(groupModel.value, (item: ServerGroupModel) => {
            count += item.servers.length;
        });
        return count;
    }
    return 0;
});

watch(editName, (data, old) => {
    if (data === null || old) return;
    nextTick(() => {
        const el = editNameInputRef.value;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.select();
    });
});

/** 搜索用：统一成小写并去首尾空格，实现大小写不敏感、忽略两端空白。 */
function match(row: RowData) {
    const keyword = props.searchKeyword.trim().toLowerCase();
    let title = "";
    if (isGroupModel(row)) {
        title = row.name;
    } else if (isServerModel(row)) {
        title = `${row.name} ${row.ip}:${row.port} ${row.user}`;
    }
    return title.toLowerCase().includes(keyword);
}

/** 批量打开：先清空再逐个 add，保证用户明确从当前列表发起一批新会话。 */
async function openServers(servers: ServerDataModel[], isGroup: boolean = false) {
    if (!servers.length) return;
    const from = new URLSearchParams(location.search).get("from");
    if (!from) return;
    if (isGroup) {
        emitTo<ChannelInstanceGroupCreatePayload>(
            {
                kind: "Window",
                label: from,
            },
            CHANNEL_INSTANCE_GROUP_CREATE_EVENT,
            { ids: servers.map((item) => item.id) },
        );
    } else {
        servers.map((server) => {
            emitTo<ServerTreeClickServerPayload>(
                {
                    kind: "Window",
                    label: from,
                },
                SERVER_TREE_CLICK_SERVER_EVENT,
                { id: server.id },
            );
        });
    }
    getCurrentWindow().destroy();
}

/**
 * 打开某分组下全部服务器（
 */
function openGroup() {
    if (isExpanded.value) {
        props.expandedGroupIds.delete(groupModel.value.id);
    } else {
        props.expandedGroupIds.add(groupModel.value.id);
    }
}
// 过滤掉分组已经选择 分组下服务器也选中的服务器  只保留最上级选中的分组
function groupHaveInList(group: ServerGroupModel | undefined, list: RowData[]) {
    if (!group) return false;
    if (isRoot(group)) return false;
    if (list.includes(group)) return true;
    return groupHaveInList(group.parent!, list);
}

/** 目标能否接收 list（不可移入自身或子孙分组，与粘贴校验一致）。 */
function canTargetAcceptData(target: RowData, list: RowData[]) {
    if (!list.length) return false;
    if (isServerModel(target) && groupHaveInList(target.group!, list)) return false;
    if (isGroupModel(target) && groupHaveInList(target, list)) return false;
    return true;
}

/**
 * 与 moveData 共享的顶层过滤：
 * 选中父分组时不再单独移动它的子分组 / 服务器，避免真实移动与预览出现重复节点。
 */
function getTopMoveData(list: RowData[]) {
    const topData: RowData[] = [];
    for (const item of list) {
        if (isRoot(item)) continue;
        if (isServerModel(item)) {
            if (!groupHaveInList(item.group, list)) {
                topData.push(item);
            }
        } else if (isGroupModel(item)) {
            if (!groupHaveInList(item.parent, list)) {
                topData.push(item);
            }
        }
    }
    return topData;
}

/**
 * 单击服务器行：多选键按下时只切换选中状态，不打开连接；
 * 普通单击则单选该服务器、清空已有通道并打开新连接（与多选操作语义区分）。
 */
let lastClickTime = 0;
function clickRow() {
    const now = Date.now();
    // 如果点击时间小于100ms 则认为是双击
    if (now - lastClickTime < 500) {
        return;
    }
    lastClickTime = now;
    if (isMultiSelectKey.value) {
        if (isSelected.value) {
            props.selectedRawData.delete(props.row);
        } else {
            props.selectedRawData.add(props.row);
        }
    } else if (onlySelectThis.value) {
        if (isServerModel(props.row)) {
            openServers([props.row]);
        } else if (isGroupModel(props.row)) {
            openGroup();
        }
        return;
    } else {
        props.selectedRawData.clear();
        props.selectedRawData.add(props.row);
    }
}
/** 修改名称行 */
function clickName() {
    if (!isMultiSelectKey.value && onlySelectThis.value) {
        editName.value = props.row.name;
        return;
    }
    clickRow();
}
/** 确认名称 */
function confirmName(blur: boolean = false) {
    try {
        if (!editName.value) return;
        props.row.name = editName.value;
        serverDataChange(props.row);
    } finally {
        editName.value = null;
    }
}

// 移动数据 如果move为false则表示复制
// 先过滤掉分组已经选择 分组下服务器也选中的服务器  只保留最上级选中的分组
function moveData(list: RowData[], target: RowData, move: boolean = false) {
    const group = isServerModel(target) ? target.group : (target as ServerGroupModel);
    if (!group) return;
    const topData = getTopMoveData(list);
    const groupList = topData.filter((item) => isGroupModel(item));
    const serverList = topData.filter((item) => isServerModel(item));
    const nowGroup = isServerModel(target) ? target.group! : (target as ServerGroupModel);
    const maxServerOrder = nowGroup.servers.reduce((max, item) => Math.max(max, item.order), 0);
    const maxGroupOrder = nowGroup.children.reduce((max, item) => Math.max(max, item.order), 0);
    const targetIsGroup = isGroupModel(target);
    const __baseOrder = targetIsGroup ? maxServerOrder + 1 : target.order + 1; // 算出服务器的插入位置
    const __baseGroupOrder = targetIsGroup ? target.order + 1 : maxGroupOrder + 1;
    if (!move) {
        // 复制时需要将每个节点的id重新生成
        const copyServerList = serverList.map((item, index) => {
            return {
                ...item,
                id: uuid(),
                order: __baseOrder + index, // 服务器直接加到target的后面 如果target时分组 就0开始
            };
        });
        serverList.length = 0;
        serverList.push(...copyServerList);
        const copyGroupList = treeForMap(
            groupList.map((item, index) => ({ ...item, order: __baseGroupOrder + index })),
            (item: ServerGroupModel) => {
                return {
                    ...item,
                    id: uuid(),
                    servers: item.servers.map((sv) => {
                        return {
                            ...sv,
                            id: uuid(),
                        };
                    }),
                };
            },
        );
        groupList.length = 0;
        groupList.push(...copyGroupList);
    } else {
        // 剪切时 先删除原先的group和server
        groupList.forEach((item, index) => {
            item.parent!.children = item.parent?.children?.filter((it) => it.id !== item.id) || [];
            item.order = __baseGroupOrder + index;
        });
        serverList.forEach((item, index) => {
            item.group!.servers = item.group!.servers.filter((it) => it.id !== item.id) || [];
            item.order = __baseOrder + index;
        });
    }
    // 修改nowGroup.servers的order
    nowGroup.servers.forEach((item) => {
        if (item.order < __baseOrder) return; // 小于插入位置的 不修改
        item.order = item.order + serverList.length; // order直接加copyServerList.length
    });
    // 修改nowGroup.children的order
    nowGroup.children.forEach((item) => {
        if (item.order < __baseGroupOrder) return; // 小于插入位置的 不修改
        item.order = item.order + groupList.length; // order直接加groupList.length
    });
    nowGroup.children.push(...groupList);
    nowGroup.servers.push(...serverList);
    serverDataChange(nowGroup);
}

function copy() {
    props.copyData.type = "copy";
    props.copyData.data = Array.from(props.selectedRawData.values());
}

function cut() {
    props.copyData.type = "cut";
    props.copyData.data = Array.from(props.selectedRawData.values());
}

function paste(data: RowData) {
    moveData(props.copyData.data, data, props.copyData.type === "cut");
    // 剪切时 粘贴后清空剪切板数据
    if (props.copyData.type === "cut") props.copyData.data = [];
    if (isGroupModel(data)) {
        props.expandedGroupIds.add(data.id);
    }
}

/** 新建服务器统一进入 edit-server 窗口，保存后由窗口事件刷新当前树。 */
function openCreateServerWindow(data: RowData) {
    const group = isServerModel(data) ? data.group : (data as ServerGroupModel);
    openOrFocusEditServerWindow({
        mode: "create",
        groupId: group?.id ?? serverRootGroup.value.id,
    });
}

/** 编辑服务器统一进入 edit-server 窗口，避免在树行内塞复杂表单状态。 */
function openEditServerWindow(data: RowData) {
    if (!isServerModel(data)) return;
    openOrFocusEditServerWindow({
        mode: "edit",
        serverId: data.id,
        groupId: data.group?.id,
    });
}

/** 打开上下文菜单 */
function openContextMenu(e: MouseEvent, notRow: boolean = false) {
    e.preventDefault();
    e.stopPropagation();
    const multiSelect = props.selectedRawData.size > 1;
    const data = notRow ? serverRootGroup.value : props.row;
    if (!multiSelect && !notRow) {
        props.selectedRawData.clear();
        props.selectedRawData.add(data);
    }
    const dataHaveInCopyData = !notRow && !canTargetAcceptData(data, props.copyData.data);
    const sl = selectedServers.value.length;
    const isRootRow = isRoot(data);
    const link = [
        {
            label: (isGroup || multiSelect) && !notRow ? `连接(${sl})` : "连接",
            handler: () => {
                openServers(selectedServers.value);
            },
            disabled: notRow,
        },
        {
            label: `融合终端(+${sl})`,
            handler: () => {
                openServers(selectedServers.value, true);
            },
            disabled: sl < 2,
        },
    ];
    const copys = [
        {
            label: "复制",
            handler: copy,
            disabled: isRootRow,
        },
        {
            label: "剪切",
            handler: cut,
            disabled: isRootRow,
        },
        {
            label: "粘贴",
            handler: () => paste(data),
            disabled: props.copyData.data.length === 0 || dataHaveInCopyData,
        },
    ];
    const del = {
        label: `删除${multiSelect ? `(${props.selectedRawData.size})` : ""}`,
        handler: async () => {
            const ok = await showConfirm({
                title: "确认删除",
                message: `确定要删除${props.selectedRawData.size}项吗？此操作不可恢复。`,
                danger: true,
            });
            if (!ok) return;
            props.selectedRawData.forEach((item) => {
                deleteServerRow(item);
            });
        },
        disabled: isRootRow,
    };
    const rename = {
        label: "重命名",
        handler: () => {
            editName.value = data.name;
        },
        disabled: isRootRow || !onlySelectThis.value,
    };
    const createServer = {
        label: "新建服务器",
        handler: () => openCreateServerWindow(data),
    };
    const sync = [
        {
            label: "导出",
            children: [
                {
                    label: "导出全部",
                    handler: () => {
                        exportServerData([serverRootGroup.value])
                            .finally(() => {
                                showToast("导出成功", "success");
                            })
                            .catch(() => {
                                showToast("导出失败", "error");
                            });
                    },
                },
                {
                    label: "导出选中",
                    handler: () => {
                        if (props.selectedRawData.has(serverRootGroup.value)) {
                            exportServerData([serverRootGroup.value])
                                .finally(() => {
                                    showToast("导出成功", "success");
                                })
                                .catch(() => {
                                    showToast("导出失败", "error");
                                });
                            return;
                        }
                        const list = getTopMoveData(Array.from(props.selectedRawData.values()));
                        exportServerData(list)
                            .finally(() => {
                                showToast("导出成功", "success");
                            })
                            .catch(() => {
                                showToast("导出失败", "error");
                            });
                    },
                },
            ],
        },
        {
            label: "导入",
            handler: () => {
                importServerData(isServerModel(data) ? data.group! : (data as ServerGroupModel));
            },
        },
        {
            label: "同步",
            handler: () => {
                openOrFocusSettingsWindow("server");
            },
        },
    ];
    const serverMenus = [
        ...link,
        "---",
        {
            label: "编辑",
            handler: () => openEditServerWindow(data),
            disabled: isRootRow || !onlySelectThis.value,
        },
        rename,
        "---",
        ...copys,
        "---",
        del,
        "---",
        {
            label: "复制地址",
            handler: () => {
                void copyText(`${serverModel.value.ip}:${serverModel.value.port}`);
            },
            disabled: !onlySelectThis.value,
        },
        "---",
        createServer,
        "---",
        ...sync,
    ];
    const groupMenus = [
        ...link,
        rename,
        "---",
        ...copys,
        "---",
        del,
        "---",
        {
            label: "新建分组",
            handler: () => {
                const group = data as ServerGroupModel;
                const maxGroupOrder = group.children.reduce((max, item) => Math.max(max, item.order), 0);
                const newGroup = {
                    name: "",
                    order: maxGroupOrder + 1,
                    children: [],
                    servers: [],
                };
                props.expandedGroupIds.add(group.id);
                addServerGroup(newGroup, group);
            },
        },
        createServer,
        "---",
        ...sync,
    ];
    // 通过全局自定义事件交给布局层渲染通用上下文菜单（与具体菜单组件解耦）。
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus: isGroupModel(data) ? groupMenus : serverMenus, target: e } }));
}

function bodyKeydown(e: KeyboardEvent): boolean {
    let result = false;
    if (e.key === "Enter") {
        if (onlySelectThis.value) {
            editName.value = props.row.name;
        }
        result = true;
    }
    // 只有跟节点监听剪切板操作
    else if (isRoot(props.row)) {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === "c") {
            copy();
            result = true;
        } else if (ctrl && e.key === "x") {
            cut();
            result = true;
        } else if (ctrl && e.key === "v") {
            // 粘贴时 如果只有一项 则粘贴
            if (props.selectedRawData.size === 1) {
                paste(Array.from(props.selectedRawData.values())[0]);
                result = true;
            }
        }
    }
    return result;
}

function treeContextmenu(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e as MouseEvent, true);
}

onMounted(() => {
    document.getElementsByClassName("server-tree-card")[0]?.addEventListener("contextmenu", treeContextmenu);
    // id为空表示新建的分组
    if (!props.row.name) {
        props.row.name = "新建分组";
        editName.value = props.row.name;
        serverDataChange(props.row);
    }
    if (isRoot(props.row)) {
        getCurrentWindow()
            .listen<EditServerSavedPayload>(EDIT_SERVER_SAVED_EVENT, async ({ payload }) => {
                await reloadServerData();
                const server = findServerDataById(payload.editId);
                if (server) {
                    props.selectedRawData.clear();
                    props.selectedRawData.add(server);
                }
                if (payload.connect && server) {
                    await openServers([server]);
                }
            })
            .then((unlisten) => {
                closeFuns.push(unlisten);
            });
    }
});

onUnmounted(() => {
    document.getElementsByClassName("server-tree-card")[0]?.removeEventListener("contextmenu", treeContextmenu);
    closeFuns.forEach((unlisten) => unlisten());
});

closeFuns.push(keyEventStore.register(bodyKeydown));

// 拖动相关代码
const isDragPreviewTarget = ref<number>(0); // 0 不是目标 1 是目标并且可以移动 2 是目标但是不能移动
const __injectKey = "server-tree-row-drag-state";
const dargFlag = inject<Ref<boolean>>(__injectKey, ref(false));
if (isRoot(props.row)) {
    provide(__injectKey, dargFlag);
}
function dragstart() {
    dargFlag.value = true;
    if (props.selectedRawData.size === 0) {
        props.selectedRawData.add(props.row);
    } else if (props.selectedRawData.size === 1) {
        props.selectedRawData.clear();
        props.selectedRawData.add(props.row);
    }
}
function dragover() {
    const canMove = canTargetAcceptData(props.row, Array.from(props.selectedRawData.values()));
    if (canMove) {
        isDragPreviewTarget.value = 1;
    } else {
        isDragPreviewTarget.value = 2;
    }
}
function dragleave() {
    isDragPreviewTarget.value = 0;
}
function drop() {
    try {
        if (isDragPreviewTarget.value !== 1) return;
        moveData(Array.from(props.selectedRawData.values()), props.row, true);
    } finally {
        isDragPreviewTarget.value = 0;
    }
}
function dragEnd() {
    dargFlag.value = false;
}
</script>

<template>
    <template v-if="show">
        <div v-if="isGroup" :draggable="!isRoot(row)" @dragstart.stop="dragstart" @dragover.stop="dragover" @dragleave.stop="dragleave" @drop.stop="drop" @dragend.stop="dragEnd">
            <div
                class="server-tree-row server-tree-group-row"
                type="button"
                :class="{
                    'server-tree-row-open': expandedGroupIds.has(groupModel.id),
                    'server-tree-row-empty': groupEmpty,
                    'server-tree-row-selected': isSelected,
                    'row-is-cut': isCut,
                    'server-tree-row-drag-target': isDragPreviewTarget === 1,
                    'server-tree-row-drag-target-not-allow': isDragPreviewTarget === 2,
                }"
                :title="path"
                @click.stop="clickRow()"
                @dblclick="openGroup()"
                @contextmenu.stop="openContextMenu($event)"
            >
                <span class="server-tree-name-cell" :style="{ paddingLeft: level * 22 + 'px' }">
                    <span class="server-tree-indent" aria-hidden="true"></span>
                    <Icon :icon="!groupEmpty ? 'lucide:chevron-right' : 'lucide:minus'" class="server-tree-toggle" aria-hidden="true" @click.stop="openGroup()" />
                    <Icon icon="flat-color-icons:folder" class="server-tree-folder-icon" aria-hidden="true" />
                    <SystemInput
                        v-if="editName !== null"
                        ref="editNameInputRef"
                        v-model="editName"
                        class="server-tree-name-input"
                        @blur="confirmName(true)"
                        @keydown.enter.stop="confirmName"
                        @keydown.esc="editName = null"
                        @click.stop
                    />
                    <span v-else class="server-tree-name" @click.stop="clickName()" @dblclick.stop="">{{ row.name }}</span>
                </span>
                <span class="server-tree-muted">{{ serverCount }}</span>
                <span class="server-tree-muted"></span>
                <span class="server-tree-muted"></span>
                <span class="server-tree-muted"></span>
            </div>
            <div v-if="isExpanded">
                <ServerTreeRow
                    v-for="child in previewChildren"
                    :key="child.id"
                    :row="child"
                    :level="level + 1"
                    :selectedRawData="selectedRawData"
                    :expandedGroupIds="expandedGroupIds"
                    :copyData="copyData"
                    :searchKeyword="searchKeyword"
                />
                <ServerTreeRow
                    v-for="server in previewServers"
                    :key="server.id"
                    :row="server"
                    :level="level + 1"
                    :selectedRawData="selectedRawData"
                    :expandedGroupIds="expandedGroupIds"
                    :copyData="copyData"
                    :searchKeyword="searchKeyword"
                />
            </div>
        </div>
        <div
            v-else
            class="server-tree-row server-tree-server-row"
            type="button"
            :class="{
                'server-tree-row-selected': isSelected,
                'row-is-cut': isCut,
                'server-tree-row-drag-target': isDragPreviewTarget === 1,
                'server-tree-row-drag-target-not-allow': isDragPreviewTarget === 2,
            }"
            :title="`${serverModel.name}  ${serverModel.ip}:${serverModel.port}`"
            tabindex="0"
            draggable="true"
            @click.stop="clickRow"
            @dblclick="openServers([serverModel])"
            @contextmenu.stop="openContextMenu($event)"
            @dragstart.stop="dragstart"
            @dragover.stop="dragover"
            @dragleave.stop="dragleave"
            @drop.stop="drop"
            @dragend.stop="dragEnd"
            @keydown.enter.stop="editName = row.name"
        >
            <span class="server-tree-name-cell" :style="{ paddingLeft: level * 22 + 'px' }">
                <span class="server-tree-indent" aria-hidden="true"></span>
                <span class="server-tree-toggle" aria-hidden="true"></span>
                <Icon icon="lucide:server" class="server-tree-server-icon" aria-hidden="true" />
                <SystemInput
                    v-if="editName !== null"
                    ref="editNameInputRef"
                    v-model="editName"
                    class="server-tree-name-input"
                    @blur="confirmName(true)"
                    @keydown.enter.stop="confirmName"
                    @keydown.esc.stop="editName = null"
                    @click.stop
                />
                <span v-else class="server-tree-name" @click.stop="clickName">{{ row.name }}</span>
            </span>
            <span class="server-tree-value">{{ serverModel.ip }}</span>
            <span class="server-tree-value">{{ serverModel.port }}</span>
            <span class="server-tree-value">{{ serverModel.user }}</span>
            <span class="server-tree-value">{{ serverModel.lastConnectAt ? dayjs(serverModel.createdAt).format("YYYY-MM-DD HH:mm:ss") : "--" }}</span>
        </div>
    </template>
</template>

<style scoped lang="scss">
/*
 * 树行布局（与 ServerTree 表头列宽对齐）。
 * - .server-tree-row-open 旋转 chevron；.server-tree-row-empty 禁止旋转。
 * - 窄屏：行改为单列，次要列（muted）隐藏。
 */
.server-tree-row {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(260px, 1.25fr) minmax(150px, 0.75fr) minmax(72px, 0.28fr) minmax(110px, 0.48fr) minmax(160px, 0.7fr);
    gap: 16px;
    align-items: center;
    min-height: 33px;
    padding: 0 16px;
    border: 0;
    text-align: left;
    font: inherit;
    cursor: pointer;

    &.row-is-cut {
        opacity: 0.3;
    }

    &.server-tree-row-drag-target-not-allow {
        opacity: 0.3;
    }
}

.server-tree-name-cell {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 8px;
}

.server-tree-indent {
    width: 0;
    height: 1px;
    flex: 0 0 auto;
}

.server-tree-toggle {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    transition: transform 0.16s ease;
}

.server-tree-row-open {
    .server-tree-toggle {
        transform: rotate(90deg);
    }
}

.server-tree-row-empty {
    .server-tree-toggle {
        transform: none;
    }
}

.server-tree-folder-icon,
.server-tree-server-icon {
    width: 18px;
    height: 18px;
    flex: 0 0 auto;
}

.server-tree-server-icon {
    width: 16px;
    height: 16px;
}

.server-tree-name,
.server-tree-value,
.server-tree-muted {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.server-tree-name {
    font-weight: 650;
}

.server-tree-name-input {
    flex: 1;
    min-width: 0;
    border-radius: 6px;
    padding: 2px 8px;
    outline: none;
    line-height: 1.2;
    font: inherit;
    font-weight: 650;
}

.server-tree-badge {
    min-width: 22px;
    height: 18px;
    padding: 0 7px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--font-size-xs);
    line-height: 1;
    flex: 0 0 auto;
}

@media (max-width: 760px) {
    .server-tree-row {
        grid-template-columns: 1fr;
        gap: 4px;
        padding: 8px 12px;
    }

    .server-tree-muted {
        display: none;
    }
}
</style>
