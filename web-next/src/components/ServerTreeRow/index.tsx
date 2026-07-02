"use client";

import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Icon from "@/components/Icon";
import SystemInput from "@/components/SystemInput";
import type { CopyData } from "@/components/ServerTree";
import { CHANNEL_INSTANCE_GROUP_CREATE_EVENT, type ChannelInstanceGroupCreatePayload, SERVER_TREE_CLICK_SERVER_EVENT, type ServerTreeClickServerPayload } from "@/stores/channelInstances";
import { useKeyEventStore } from "@/stores/keyEvent";
import { useServerDataStore, type RowData, type ServerDataModel, type ServerGroupModel } from "@/stores/serverData";
import { CustomMenusEventKey } from "@/utils/constant";
import { copyText } from "@/utils/project";
import { showConfirm, showToast } from "@/utils/ui";
import { treeForEach, treeForMap, uuid } from "@/utils";
import { EDIT_SERVER_SAVED_EVENT, type EditServerSavedPayload, openOrFocusEditServerWindow, openOrFocusSettingsWindow } from "@/utils/window";
import type { MenuItem } from "@/components/DefaultMenuItems";
import "./index.scss";

export type ServerTreeRowProps = {
    row: RowData;
    level: number;
    selectedRawData: Set<RowData>;
    setSelectedRawData: Dispatch<SetStateAction<Set<RowData>>>;
    expandedGroupIds: Set<string>;
    setExpandedGroupIds: Dispatch<SetStateAction<Set<string>>>;
    copyData: CopyData;
    setCopyData: Dispatch<SetStateAction<CopyData>>;
    searchKeyword: string;
    setBlankContextMenu?: (handler: ((event: React.MouseEvent) => void) | null) => void;
};

function useStoreApi() {
    const store = useServerDataStore.getState();
    return {
        serverRootGroup: useServerDataStore((state) => state.serverRootGroup),
        isGroupModel: store.isGroupModel,
        isRoot: store.isRoot,
        isServerModel: store.isServerModel,
        serverDataChange: store.serverDataChange,
        deleteServerRow: store.deleteServerRow,
        addServerGroup: store.addServerGroup,
        findServerDataById: store.findServerDataById,
        reloadServerData: store.reloadServerData,
        exportServerData: store.exportServerData,
        importServerData: store.importServerData,
    };
}

export default function ServerTreeRow(props: ServerTreeRowProps) {
    const { row, level, selectedRawData, setSelectedRawData, expandedGroupIds, setExpandedGroupIds, copyData, setCopyData, searchKeyword } = props;
    const api = useStoreApi();
    const isMultiSelectKey = useKeyEventStore((state) => state.isMultiSelectKey);
    const registerKeyEvent = useKeyEventStore((state) => state.register);
    const [editName, setEditName] = useState<string | null>(null);
    const [isDragPreviewTarget, setIsDragPreviewTarget] = useState<0 | 1 | 2>(0);
    const editNameInputRef = useRef<HTMLInputElement | null>(null);
    const lastClickTime = useRef(0);

    const isGroup = api.isGroupModel(row);
    const groupModel = row as ServerGroupModel;
    const serverModel = row as ServerDataModel;
    const isSelected = selectedRawData.has(row);
    const onlySelectThis = selectedRawData.size === 1 && isSelected;
    const isCut = copyData.type === "cut" && copyData.data.includes(row);
    const isExpanded = isGroup && expandedGroupIds.has(groupModel.id);
    const groupEmpty = isGroup && groupModel.children.length === 0 && groupModel.servers.length === 0;

    const path = useMemo(() => {
        const nf = (g: ServerGroupModel): string => {
            if (api.isRoot(g) || !g.parent) return "";
            return `${nf(g.parent)}/${g.name}`;
        };
        return isGroup ? nf(groupModel) : nf(serverModel.group!);
    }, [api, groupModel, isGroup, serverModel.group]);

    const previewChildren = useMemo(() => {
        if (!isGroup) return [];
        return [...groupModel.children].sort((a, b) => a.order - b.order);
    }, [groupModel.children, isGroup]);

    const previewServers = useMemo(() => {
        if (!isGroup) return [];
        return [...groupModel.servers].sort((a, b) => a.order - b.order);
    }, [groupModel.servers, isGroup]);

    const selectedServers = useMemo<ServerDataModel[]>(() => {
        const servers: Set<ServerDataModel> = new Set();
        selectedRawData.forEach((item) => {
            if (api.isServerModel(item)) {
                servers.add(item);
            } else if (api.isGroupModel(item)) {
                treeForEach<ServerGroupModel>(item, (group: ServerGroupModel) => {
                    group.servers.forEach((server) => servers.add(server));
                });
            }
        });
        return Array.from(servers);
    }, [api, selectedRawData]);

    const serverCount = useMemo(() => {
        if (!isGroup) return 0;
        let count = 0;
        treeForEach<ServerGroupModel>(groupModel, (item: ServerGroupModel) => {
            count += item.servers.length;
        });
        return count;
    }, [groupModel, isGroup]);

    const show = useMemo(() => {
        const matchRow = (target: RowData) => {
            const keyword = searchKeyword.trim().toLowerCase();
            let title = "";
            if (api.isGroupModel(target)) title = target.name;
            else if (api.isServerModel(target)) title = `${target.name} ${target.ip}:${target.port} ${target.user}`;
            return title.toLowerCase().includes(keyword);
        };
        if (!searchKeyword.trim()) return true;
        if (isGroup) {
            return treeForEach<ServerGroupModel>(groupModel, (item: ServerGroupModel) => {
                if (item.servers?.some((sv) => matchRow(sv))) return true;
                return matchRow(item);
            });
        }
        return matchRow(row);
    }, [api, groupModel, isGroup, row, searchKeyword]);

    useEffect(() => {
        if (editName === null) return;
        const frame = requestAnimationFrame(() => {
            editNameInputRef.current?.focus({ preventScroll: true });
            editNameInputRef.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, [editName]);

    useEffect(() => {
        if (row.name) return;
        row.name = "新建分组";
        setEditName(row.name);
        void api.serverDataChange(row);
    }, [api, row]);

    useEffect(() => {
        if (!api.isRoot(row)) return;
        let unlisten: (() => void) | null = null;
        void getCurrentWindow()
            .listen<EditServerSavedPayload>(EDIT_SERVER_SAVED_EVENT, async ({ payload }) => {
                await api.reloadServerData();
                const server = api.findServerDataById(payload.editId);
                if (server) setSelectedRawData(new Set([server]));
                if (payload.connect && server) await openServers([server]);
            })
            .then((fn) => {
                unlisten = fn;
            });
        return () => unlisten?.();
    }, [api, row, setSelectedRawData]);

    useEffect(() => {
        const unregister = registerKeyEvent(bodyKeydown);
        return unregister;
    });

    function mutateSelected(call: (next: Set<RowData>) => void) {
        setSelectedRawData((prev) => {
            const next = new Set(prev);
            call(next);
            return next;
        });
    }

    function mutateExpanded(call: (next: Set<string>) => void) {
        setExpandedGroupIds((prev) => {
            const next = new Set(prev);
            call(next);
            return next;
        });
    }

    async function openServers(servers: ServerDataModel[], isGroupOpen: boolean = false) {
        if (!servers.length) return;
        const from = new URLSearchParams(location.search).get("from");
        if (!from) return;
        if (isGroupOpen) {
            await emitTo<ChannelInstanceGroupCreatePayload>({ kind: "Window", label: from }, CHANNEL_INSTANCE_GROUP_CREATE_EVENT, {
                ids: servers.map((item) => item.id),
            });
        } else {
            await Promise.all(
                servers.map((server) =>
                    emitTo<ServerTreeClickServerPayload>({ kind: "Window", label: from }, SERVER_TREE_CLICK_SERVER_EVENT, {
                        id: server.id,
                    }),
                ),
            );
        }
        await getCurrentWindow().destroy();
    }

    function openGroup() {
        if (!isGroup) return;
        mutateExpanded((next) => {
            if (next.has(groupModel.id)) next.delete(groupModel.id);
            else next.add(groupModel.id);
        });
    }

    function groupHaveInList(group: ServerGroupModel | undefined, list: RowData[]): boolean {
        if (!group) return false;
        if (api.isRoot(group)) return false;
        if (list.includes(group)) return true;
        return groupHaveInList(group.parent, list);
    }

    function canTargetAcceptData(target: RowData, list: RowData[]) {
        if (!list.length) return false;
        if (api.isServerModel(target) && groupHaveInList(target.group, list)) return false;
        if (api.isGroupModel(target) && groupHaveInList(target, list)) return false;
        return true;
    }

    function getTopMoveData(list: RowData[]) {
        const topData: RowData[] = [];
        for (const item of list) {
            if (api.isRoot(item)) continue;
            if (api.isServerModel(item)) {
                if (!groupHaveInList(item.group, list)) topData.push(item);
            } else if (api.isGroupModel(item)) {
                if (!groupHaveInList(item.parent, list)) topData.push(item);
            }
        }
        return topData;
    }

    function clickRow() {
        const now = Date.now();
        if (now - lastClickTime.current < 500) return;
        lastClickTime.current = now;
        if (isMultiSelectKey) {
            mutateSelected((next) => {
                if (next.has(row)) next.delete(row);
                else next.add(row);
            });
        } else if (onlySelectThis) {
            if (api.isServerModel(row)) void openServers([row]);
            else if (api.isGroupModel(row)) openGroup();
        } else {
            setSelectedRawData(new Set([row]));
        }
    }

    function clickName() {
        if (!isMultiSelectKey && onlySelectThis) {
            setEditName(row.name);
            return;
        }
        clickRow();
    }

    function confirmName() {
        try {
            if (!editName) return;
            row.name = editName;
            void api.serverDataChange(row);
        } finally {
            setEditName(null);
        }
    }

    function moveData(list: RowData[], target: RowData, move: boolean = false) {
        const group = api.isServerModel(target) ? target.group : (target as ServerGroupModel);
        if (!group) return;
        const topData = getTopMoveData(list);
        const groupList = topData.filter((item): item is ServerGroupModel => api.isGroupModel(item));
        const serverList = topData.filter((item): item is ServerDataModel => api.isServerModel(item));
        const nowGroup = api.isServerModel(target) ? target.group! : (target as ServerGroupModel);
        const maxServerOrder = nowGroup.servers.reduce((max, item) => Math.max(max, item.order), 0);
        const maxGroupOrder = nowGroup.children.reduce((max, item) => Math.max(max, item.order), 0);
        const targetIsGroup = api.isGroupModel(target);
        const __baseOrder = targetIsGroup ? maxServerOrder + 1 : target.order + 1;
        const __baseGroupOrder = targetIsGroup ? target.order + 1 : maxGroupOrder + 1;
        if (!move) {
            const copyServerList = serverList.map((item, index) => ({ ...item, id: uuid(), order: __baseOrder + index }));
            serverList.length = 0;
            serverList.push(...copyServerList);
            const copyGroupList = treeForMap(
                groupList.map((item, index) => ({ ...item, order: __baseGroupOrder + index })),
                (item: ServerGroupModel) => ({
                    ...item,
                    id: uuid(),
                    servers: item.servers.map((sv) => ({ ...sv, id: uuid() })),
                }),
            );
            groupList.length = 0;
            groupList.push(...copyGroupList);
        } else {
            groupList.forEach((item, index) => {
                item.parent!.children = item.parent?.children?.filter((it) => it.id !== item.id) || [];
                item.order = __baseGroupOrder + index;
            });
            serverList.forEach((item, index) => {
                item.group!.servers = item.group!.servers.filter((it) => it.id !== item.id) || [];
                item.order = __baseOrder + index;
            });
        }
        nowGroup.servers.forEach((item) => {
            if (item.order < __baseOrder) return;
            item.order += serverList.length;
        });
        nowGroup.children.forEach((item) => {
            if (item.order < __baseGroupOrder) return;
            item.order += groupList.length;
        });
        nowGroup.children.push(...groupList);
        nowGroup.servers.push(...serverList);
        void api.serverDataChange(nowGroup);
    }

    function copy() {
        setCopyData({ type: "copy", data: Array.from(selectedRawData.values()) });
    }

    function cut() {
        setCopyData({ type: "cut", data: Array.from(selectedRawData.values()) });
    }

    function paste(data: RowData) {
        moveData(copyData.data, data, copyData.type === "cut");
        if (copyData.type === "cut") setCopyData({ type: "cut", data: [] });
        if (api.isGroupModel(data)) mutateExpanded((next) => next.add(data.id));
    }

    function openCreateServerWindow(data: RowData) {
        const group = api.isServerModel(data) ? data.group : (data as ServerGroupModel);
        void openOrFocusEditServerWindow({
            mode: "create",
            groupId: group?.id ?? api.serverRootGroup.id,
        });
    }

    function openEditServerWindow(data: RowData) {
        if (!api.isServerModel(data)) return;
        void openOrFocusEditServerWindow({
            mode: "edit",
            serverId: data.id,
            groupId: data.group?.id,
        });
    }

    function openContextMenu(e: React.MouseEvent | MouseEvent, notRow: boolean = false) {
        e.preventDefault();
        e.stopPropagation();
        const multiSelect = selectedRawData.size > 1;
        const data = notRow ? api.serverRootGroup : row;
        if (!multiSelect && !notRow) setSelectedRawData(new Set([data]));
        const dataHaveInCopyData = !notRow && !canTargetAcceptData(data, copyData.data);
        const sl = selectedServers.length;
        const isRootRow = api.isRoot(data);
        const link: MenuItem[] = [
            {
                label: (isGroup || multiSelect) && !notRow ? `连接(${sl})` : "连接",
                handler: () => void openServers(selectedServers),
                disabled: notRow,
            },
            {
                label: `融合终端(+${sl})`,
                handler: () => void openServers(selectedServers, true),
                disabled: sl < 2,
            },
        ];
        const copys: MenuItem[] = [
            { label: "复制", handler: copy, disabled: isRootRow },
            { label: "剪切", handler: cut, disabled: isRootRow },
            { label: "粘贴", handler: () => paste(data), disabled: copyData.data.length === 0 || dataHaveInCopyData },
        ];
        const del: MenuItem = {
            label: `删除${multiSelect ? `(${selectedRawData.size})` : ""}`,
            handler: async () => {
                const ok = await showConfirm({
                    title: "确认删除",
                    message: `确定要删除${selectedRawData.size}项吗？此操作不可恢复。`,
                    danger: true,
                });
                if (!ok) return;
                await Promise.all(Array.from(selectedRawData).map((item) => api.deleteServerRow(item)));
            },
            disabled: isRootRow,
        };
        const rename: MenuItem = {
            label: "重命名",
            handler: () => setEditName(data.name),
            disabled: isRootRow || !onlySelectThis,
        };
        const createServer: MenuItem = {
            label: "新建服务器",
            handler: () => openCreateServerWindow(data),
        };
        const sync: MenuItem[] = [
            {
                label: "导出",
                children: [
                    {
                        label: "导出全部",
                        handler: () => {
                            api.exportServerData([api.serverRootGroup])
                                .finally(() => showToast("导出成功", "success"))
                                .catch(() => showToast("导出失败", "error"));
                        },
                    },
                    {
                        label: "导出选中",
                        handler: () => {
                            const list = selectedRawData.has(api.serverRootGroup) ? [api.serverRootGroup] : getTopMoveData(Array.from(selectedRawData.values()));
                            api.exportServerData(list)
                                .finally(() => showToast("导出成功", "success"))
                                .catch(() => showToast("导出失败", "error"));
                        },
                    },
                ],
            },
            {
                label: "导入",
                handler: () => void api.importServerData(api.isServerModel(data) ? data.group! : (data as ServerGroupModel)),
            },
            {
                label: "同步",
                handler: () => void openOrFocusSettingsWindow("server"),
            },
        ];
        const serverMenus: MenuItem[] = [
            ...link,
            "---",
            { label: "编辑", handler: () => openEditServerWindow(data), disabled: isRootRow || !onlySelectThis },
            rename,
            "---",
            ...copys,
            "---",
            del,
            "---",
            { label: "复制地址", handler: () => void copyText(`${serverModel.ip}:${serverModel.port}`), disabled: !onlySelectThis },
            "---",
            createServer,
            "---",
            ...sync,
        ];
        const groupMenus: MenuItem[] = [
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
                    mutateExpanded((next) => next.add(group.id));
                    void api.addServerGroup({ name: "" }, group);
                },
            },
            createServer,
            "---",
            ...sync,
        ];
        document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus: api.isGroupModel(data) ? groupMenus : serverMenus, target: e } }));
    }

    function bodyKeydown(e: KeyboardEvent): boolean {
        let result = false;
        if (e.key === "Enter") {
            if (onlySelectThis) setEditName(row.name);
            result = true;
        } else if (api.isRoot(row)) {
            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.key === "c") {
                copy();
                result = true;
            } else if (ctrl && e.key === "x") {
                cut();
                result = true;
            } else if (ctrl && e.key === "v") {
                if (selectedRawData.size === 1) {
                    paste(Array.from(selectedRawData.values())[0]);
                    result = true;
                }
            }
        }
        return result;
    }

    useEffect(() => {
        if (!api.isRoot(row) || !props.setBlankContextMenu) return;
        // Vue 版允许在树卡片空白处右键打开根节点菜单；这里用 React 事件注册，避免原生祖先监听抢在行事件前触发。
        props.setBlankContextMenu((event) => openContextMenu(event, true));
        return () => props.setBlankContextMenu?.(null);
    });

    function dragstart() {
        if (selectedRawData.size === 0 || selectedRawData.size === 1) setSelectedRawData(new Set([row]));
    }

    function dragover(event: React.DragEvent) {
        event.preventDefault();
        const canMove = canTargetAcceptData(row, Array.from(selectedRawData.values()));
        setIsDragPreviewTarget(canMove ? 1 : 2);
    }

    function drop() {
        try {
            if (isDragPreviewTarget !== 1) return;
            moveData(Array.from(selectedRawData.values()), row, true);
        } finally {
            setIsDragPreviewTarget(0);
        }
    }

    if (!show) return null;

    if (isGroup) {
        return (
            <div
                className="ServerTreeRow"
                draggable={!api.isRoot(row)}
                onDragStart={dragstart}
                onDragOver={dragover}
                onDragLeave={() => setIsDragPreviewTarget(0)}
                onDrop={drop}
                onDragEnd={() => setIsDragPreviewTarget(0)}
            >
                <div
                    className={`server-tree-row server-tree-group-row${isExpanded ? " server-tree-row-open" : ""}${groupEmpty ? " server-tree-row-empty" : ""}${isSelected ? " server-tree-row-selected" : ""}${isCut ? " row-is-cut" : ""}${
                        isDragPreviewTarget === 1 ? " server-tree-row-drag-target" : ""
                    }${isDragPreviewTarget === 2 ? " server-tree-row-drag-target-not-allow" : ""}`}
                    title={path}
                    onClick={(event) => {
                        event.stopPropagation();
                        clickRow();
                    }}
                    onDoubleClick={openGroup}
                    onContextMenuCapture={(event) => openContextMenu(event)}
                >
                    <span className="server-tree-name-cell" style={{ paddingLeft: `${level * 22}px` }}>
                        <span className="server-tree-indent" aria-hidden="true" />
                        <Icon
                            icon={!groupEmpty ? "lucide:chevron-right" : "lucide:minus"}
                            className="server-tree-toggle"
                            aria-hidden="true"
                            onClick={(event) => {
                                event.stopPropagation();
                                openGroup();
                            }}
                        />
                        <Icon icon="flat-color-icons:folder" className="server-tree-folder-icon" aria-hidden="true" />
                        {editName !== null ? (
                            <SystemInput
                                ref={editNameInputRef as never}
                                value={editName}
                                onChange={setEditName}
                                className="server-tree-name-input"
                                onBlur={confirmName}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") confirmName();
                                    else if (event.key === "Escape") setEditName(null);
                                }}
                                onClick={(event) => event.stopPropagation()}
                            />
                        ) : (
                            <span
                                className="server-tree-name"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    clickName();
                                }}
                                onDoubleClick={(event) => event.stopPropagation()}
                            >
                                {row.name}
                            </span>
                        )}
                    </span>
                    <span className="server-tree-muted">{serverCount}</span>
                    <span className="server-tree-muted" />
                    <span className="server-tree-muted" />
                    <span className="server-tree-muted" />
                </div>
                {isExpanded ? (
                    <div>
                        {previewChildren.map((child) => (
                            <ServerTreeRow key={child.id} {...props} row={child} level={level + 1} />
                        ))}
                        {previewServers.map((server) => (
                            <ServerTreeRow key={server.id} {...props} row={server} level={level + 1} />
                        ))}
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div
            className={`ServerTreeRow server-tree-row server-tree-server-row${isSelected ? " server-tree-row-selected" : ""}${isCut ? " row-is-cut" : ""}${isDragPreviewTarget === 1 ? " server-tree-row-drag-target" : ""}${
                isDragPreviewTarget === 2 ? " server-tree-row-drag-target-not-allow" : ""
            }`}
            title={`${serverModel.name}  ${serverModel.ip}:${serverModel.port}`}
            tabIndex={0}
            draggable
            onClick={(event) => {
                event.stopPropagation();
                clickRow();
            }}
            onDoubleClick={() => void openServers([serverModel])}
            onContextMenuCapture={(event) => openContextMenu(event)}
            onDragStart={dragstart}
            onDragOver={dragover}
            onDragLeave={() => setIsDragPreviewTarget(0)}
            onDrop={drop}
            onDragEnd={() => setIsDragPreviewTarget(0)}
            onKeyDown={(event) => {
                if (event.key === "Enter") setEditName(row.name);
            }}
        >
            <span className="server-tree-name-cell" style={{ paddingLeft: `${level * 22}px` }}>
                <span className="server-tree-indent" aria-hidden="true" />
                <span className="server-tree-toggle" aria-hidden="true" />
                <Icon icon="lucide:server" className="server-tree-server-icon" aria-hidden="true" />
                {editName !== null ? (
                    <SystemInput
                        ref={editNameInputRef as never}
                        value={editName}
                        onChange={setEditName}
                        className="server-tree-name-input"
                        onBlur={confirmName}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") confirmName();
                            else if (event.key === "Escape") setEditName(null);
                        }}
                        onClick={(event) => event.stopPropagation()}
                    />
                ) : (
                    <span
                        className="server-tree-name"
                        onClick={(event) => {
                            event.stopPropagation();
                            clickName();
                        }}
                    >
                        {row.name}
                    </span>
                )}
            </span>
            <span className="server-tree-value">{serverModel.ip}</span>
            <span className="server-tree-value">{serverModel.port}</span>
            <span className="server-tree-value">{serverModel.user}</span>
            <span className="server-tree-value">{serverModel.lastConnectAt ? dayjs(serverModel.createdAt).format("YYYY-MM-DD HH:mm:ss") : "--"}</span>
        </div>
    );
}
