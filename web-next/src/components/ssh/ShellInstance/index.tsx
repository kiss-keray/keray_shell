"use client";

import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import type { MenuItem } from "@/components/DefaultMenuItems";
import { useSClick } from "@/hooks/useSClick";
import { useAppStore } from "@/stores/app";
import {
    CHANNEL_INSTANCE_MOVE_TO_WINDOW_EVENT,
    isChannelInstance,
    isChannelInstanceGroup,
    useChannelInstancesStore,
    type ChannelData,
    type ChannelInstance,
    type ChannelInstanceMoveToWindowPayload,
} from "@/stores/channelInstances";
import { CustomMenusEventKey } from "@/utils/constant";
import { dragListener } from "@/utils/project";
import { openOrFocusChildWindow } from "@/utils/window";
import "./index.scss";

const DRAG_START_EVENT = "sid_new_window_dragstart";
const DRAG_END_EVENT = "sid_new_window_dragend";
const DRAG_ENTER_EVENT = "sid_new_window_drags_enter";
const DRAG_LEAVE_EVENT = "sid_new_window_drags_leave";
const DRAG_OK_EVENT = "sid_new_window_ok";

type ShellTabItemProps = {
    item: ChannelData;
    active: boolean;
    onSelect: (item: ChannelData) => void;
    onDragStart: (event: React.DragEvent<HTMLDivElement>, item: ChannelData) => void;
    onDragEnd: (event: React.DragEvent<HTMLDivElement>, item: ChannelData) => void;
    onDragEnter: (item: ChannelData) => void;
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>, item: ChannelData) => void;
    onClose: (item: ChannelData) => void;
};

function ShellTabItem({ item, active, onSelect, onDragStart, onDragEnd, onDragEnter, onContextMenu, onClose }: ShellTabItemProps) {
    const tabRef = useRef<HTMLDivElement>(null);
    // 对齐 Vue 的 v-sclick：普通点击选中，拖动排序/拆窗后的 mouseup 不触发选中。
    useSClick(tabRef, () => onSelect(item));

    return (
        <div
            ref={tabRef}
            className={`item${active ? " active" : ""}`}
            draggable
            onDragStart={(event) => onDragStart(event, item)}
            onDragEnd={(event) => onDragEnd(event, item)}
            onDragEnter={() => onDragEnter(item)}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
            }}
            onContextMenu={(event) => onContextMenu(event, item)}
        >
            <p>{isChannelInstance(item) ? item.server.name : `融合终端(+${item.instances.length})`}</p>
            <div
                className={`status xy-center${isChannelInstance(item) && item.status === "disconnected" ? " dis" : ""}${isChannelInstanceGroup(item) || (isChannelInstance(item) && item.status === "connected") ? " connect" : ""}${
                    active ? " active" : ""
                }`}
                onClick={(event) => {
                    event.stopPropagation();
                    onClose(item);
                }}
            >
                <Icon icon="si:close-duotone" className="pointer icon hidden" />
            </div>
        </div>
    );
}

export default function ShellInstance() {
    const root = useRef<HTMLDivElement | null>(null);
    const dragPayload = useRef<ChannelInstanceMoveToWindowPayload | null>(null);
    const dragOverOtherWindow = useRef(false);
    const dragsPosition = useRef<{ x: number; y: number; data: ChannelInstanceMoveToWindowPayload | null }>({ x: -1, y: -1, data: null });
    const tabReorderSource = useRef<string | null>(null);
    const [left, setLeft] = useState(0);
    const instances = useChannelInstancesStore((state) => state.instances);
    const selectUid = useChannelInstancesStore((state) => state.selectSessionId);
    const channelStore = useChannelInstancesStore();
    const app = useAppStore();

    async function closeWindowIfEmpty() {
        if (useChannelInstancesStore.getState().instances.length > 0) return;
        if (useAppStore.getState().isMainWin) return;
        await getCurrentWindow().destroy();
    }

    function createMovePayload(item: ChannelInstance): ChannelInstanceMoveToWindowPayload {
        // 移动 tab 前采集 Term/SFTP 等子模块快照；目标窗口收到后写回 instance.snapshot 恢复 UI 状态。
        const snapshot = Object.entries(item.snapshotFn).reduce(
            (acc, [key, fn]) => {
                acc[key] = fn();
                return acc;
            },
            {} as Record<string, unknown>,
        );
        return {
            instance: { ...item, snapshotFn: {} },
            snapshot,
            window: getCurrentWindow().label,
        };
    }

    async function moveToNewWindow(item: ChannelData) {
        if (!isChannelInstance(item) || instances.length <= 1) return;
        const appWindow = getCurrentWindow();
        const payload = createMovePayload(item);
        const position = await appWindow.outerPosition();
        channelStore.del(item);
        await openOrFocusChildWindow(item, {
            x: position.x / app.scaleFactor + 32,
            y: position.y / app.scaleFactor + 32,
            width: document.body.clientWidth,
            height: document.body.clientHeight,
            fullscreen: app.isFullScreenWindow,
            ...payload,
        });
        await closeWindowIfEmpty();
    }

    async function mergeToMainWindow(item: ChannelData) {
        const appWindow = getCurrentWindow();
        if (!app.mainLabel || app.mainLabel === appWindow.label || !isChannelInstance(item)) return;
        const payload = createMovePayload(item);
        await emitTo<ChannelInstanceMoveToWindowPayload>({ kind: "Window", label: app.mainLabel }, CHANNEL_INSTANCE_MOVE_TO_WINDOW_EVENT, payload);
        channelStore.del(item);
        await closeWindowIfEmpty();
    }

    function closeInstances(items: ChannelData[]) {
        items.forEach((item) => {
            channelStore.del(item);
            /** 关闭 tab 对应的后端终端；融合终端需要逐个关闭组内 session。 */
            if (isChannelInstance(item)) {
                void invoke("close_term", { sid: item.sessionId });
                return;
            }
            item.instances.forEach((instance) => void invoke("close_term", { sid: instance.sessionId }));
        });
        void closeWindowIfEmpty();
    }

    function dragOk(payload: ChannelInstanceMoveToWindowPayload) {
        const server = payload.instance;
        server.snapshot = payload.snapshot;
        channelStore.add(server);
    }

    async function dragstart(e: React.DragEvent, item: ChannelData) {
        tabReorderSource.current = item.sessionId;
        e.dataTransfer.clearData();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-keray-shell-tab", item.sessionId);
        if (!isChannelInstance(item)) return;
        const payload = createMovePayload(item);
        dragsPosition.current = { x: e.screenX, y: e.screenY, data: payload };
        dragOverOtherWindow.current = false;
        await emitTo<ChannelInstanceMoveToWindowPayload>({ kind: "Any" }, DRAG_START_EVENT, payload);
    }

    async function dragend(e: React.DragEvent, item: ChannelData) {
        if (!isChannelInstance(item)) return;
        const appWindow = getCurrentWindow();
        await emitTo<string>({ kind: "Any" }, DRAG_END_EVENT, appWindow.label);
        const start = dragsPosition.current;
        if (start.x < 0) return;
        if (Math.abs(start.x - e.screenX) < 50 && Math.abs(start.y - e.screenY) < 50) return;
        const rect = root.current?.getBoundingClientRect();
        if (!rect) return;
        const endx = e.screenX - app.safeLeft - rect.x - 20;
        const endy = e.screenY - app.safeTop;
        const { x, y } = await appWindow.outerPosition();
        const left = x / app.scaleFactor + rect.left;
        const top = y / app.scaleFactor + rect.top;
        if (e.screenX > left && e.screenX < left + rect.width && e.screenY > top && e.screenY < top + rect.height) return;
        if (instances.length === 1) {
            await appWindow.setPosition(new LogicalPosition(endx, endy));
            return;
        }
        if (dragOverOtherWindow.current) return;
        channelStore.del(item);
        await openOrFocusChildWindow(item, {
            x: endx,
            y: endy,
            width: document.body.clientWidth,
            height: document.body.clientHeight,
            fullscreen: app.isFullScreenWindow,
            ...start.data!,
        });
        await closeWindowIfEmpty();
    }

    async function handleDragEnd(e: React.DragEvent, item: ChannelData) {
        try {
            await dragend(e, item);
        } finally {
            tabReorderSource.current = null;
        }
    }

    function reorderTabOnEnter(target: ChannelData) {
        const sourceId = tabReorderSource.current;
        if (!sourceId || sourceId === target.sessionId) return;
        // Vue 版 vuedraggable 直接维护列表顺序；React 版用 dragenter 逐步交换，拖出窗口逻辑仍由 dragend 接管。
        channelStore.reorder(sourceId, target.sessionId);
    }

    function openContextMenu(e: React.MouseEvent, item: ChannelData) {
        e.preventDefault();
        e.stopPropagation();
        const menus: MenuItem[] = [
            { label: "关闭", handler: () => closeInstances([item]) },
            { label: "关闭其他", disabled: instances.length <= 1, handler: () => closeInstances(instances.filter((v) => v !== item)) },
            { label: "关闭全部", handler: () => closeInstances([...instances]) },
            "---",
            { label: "新窗口", disabled: !isChannelInstance(item) || instances.length <= 1, handler: () => void moveToNewWindow(item) },
            { label: "融合到主窗口", disabled: !isChannelInstance(item) || app.isMainWin, handler: () => void mergeToMainWindow(item) },
        ];
        document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
    }

    useEffect(() => {
        const updateLeft = () => {
            const rect = root.current?.getBoundingClientRect();
            if (!rect || useAppStore.getState().isFullScreenWindow) {
                setLeft(0);
                return;
            }
            setLeft(Math.max(0, 80 - rect.left - window.scrollX));
        };
        updateLeft();
        const observer = new ResizeObserver(updateLeft);
        if (root.current) observer.observe(root.current);
        return () => observer.disconnect();
    }, [app.isFullScreenWindow]);

    useEffect(() => {
        if (!app.isMainWin && app.windowInitData) dragOk(app.windowInitData as ChannelInstanceMoveToWindowPayload);
        // 仅在窗口 init payload 变化时接收一次被拆出的终端实例。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [app.isMainWin, app.windowInitData]);

    useEffect(() => {
        const appWindow = getCurrentWindow();
        const unlisteners: Array<() => void> = [];
        void appWindow.listen<ChannelInstanceMoveToWindowPayload>(DRAG_START_EVENT, ({ payload }) => {
            if (payload.window === appWindow.label) return;
            dragPayload.current = payload;
        }).then((fn) => unlisteners.push(fn));
        void appWindow.listen<string>(DRAG_END_EVENT, ({ payload: label }) => {
            setTimeout(() => {
                if (dragPayload.current && dragPayload.current.window === label) dragPayload.current = null;
            }, 200);
        }).then((fn) => unlisteners.push(fn));
        void appWindow.listen(DRAG_ENTER_EVENT, () => {
            dragOverOtherWindow.current = true;
        }).then((fn) => unlisteners.push(fn));
        void appWindow.listen(DRAG_LEAVE_EVENT, () => {
            dragOverOtherWindow.current = false;
        }).then((fn) => unlisteners.push(fn));
        void appWindow.listen<ChannelInstanceMoveToWindowPayload>(DRAG_OK_EVENT, ({ payload }) => {
            const item = useChannelInstancesStore.getState().instances.find((v) => v.sessionId === payload.instance.sessionId);
            if (item) channelStore.del(item);
            void closeWindowIfEmpty();
        }).then((fn) => unlisteners.push(fn));
        void appWindow.onDragDropEvent((event) => {
            const payload = dragPayload.current;
            if (!payload) return;
            if (event.payload.type === "over" || event.payload.type === "enter") {
                void emitTo({ kind: "Window", label: payload.window }, DRAG_ENTER_EVENT);
            } else if (event.payload.type === "leave") {
                void emitTo({ kind: "Window", label: payload.window }, DRAG_LEAVE_EVENT);
            } else if (event.payload.type === "drop") {
                void emitTo({ kind: "Window", label: payload.window }, DRAG_OK_EVENT, payload);
                dragOk(payload);
                dragPayload.current = null;
            }
        }).then((fn) => unlisteners.push(fn));
        return () => unlisteners.forEach((fn) => fn());
        // 全局跨窗口拖拽监听只随组件生命周期注册，内部读 store 最新值。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let cleanup: (() => void) | undefined;
        // Tauri 原生拖拽不会自动产生 DOM dragover/drop，沿用 Vue 版桥接以保持跨窗口 tab 预览行为。
        void dragListener(() => Array.from(root.current?.querySelectorAll<HTMLElement>(".item") ?? [])).then((unlisten) => {
            cleanup = unlisten;
        });
        return () => cleanup?.();
    }, []);

    return (
        <div ref={root} className="ShellInstance module servers" data-tauri-drag-region="">
            <div style={{ width: `${left}px` }} />
            <div className="tab-list">
                {instances.map((item) => (
                    <ShellTabItem
                        key={item.sessionId}
                        item={item}
                        active={item.sessionId === selectUid}
                        onSelect={(tab) => channelStore.select(tab)}
                        onDragStart={(event, tab) => void dragstart(event, tab)}
                        onDragEnd={(event, tab) => void handleDragEnd(event, tab)}
                        onDragEnter={reorderTabOnEnter}
                        onContextMenu={openContextMenu}
                        onClose={(tab) => closeInstances([tab])}
                    />
                ))}
            </div>
        </div>
    );
}
