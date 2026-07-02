import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { uuid } from "@/utils";
import { createDefaultServerOverview, type ServerOverviewState } from "@/stores/serverOverview";
import { useServerDataStore, type ServerDataModel } from "@/stores/serverData";

export const SERVER_TREE_CLICK_SERVER_EVENT = "server_tree_click_server";

export type ServerTreeClickServerPayload = {
    id: string;
};

export const CHANNEL_INSTANCE_GROUP_CREATE_EVENT = "channel_instance_group_create";
export const CHANNEL_INSTANCE_MOVE_TO_WINDOW_EVENT = "channel_instance_move_to_window";

export type ChannelInstanceGroupCreatePayload = {
    ids: string[];
};

/** 跨窗口移动单个终端 tab 时传递的 payload，包含原窗口 label 和各模块快照。 */
export type ChannelInstanceMoveToWindowPayload = {
    window: string;
    instance: ChannelInstance;
    snapshot: Record<string, unknown>;
};

/**
 * 表示一个终端标签页对应的 SSH 通道实例。
 * overview 可选：未打开资源面板或未初始化时可能不存在。
 */
export interface ChannelInstance {
    sessionId: string; // 会话ID
    server: ServerDataModel; // 服务器数据
    status: "connecting" | "connected" | "disconnected"; // 连接中 / 已连接 / 断开
    zindex: number; // 终端叠放层级（最近操作的终端更大）
    overview?: ServerOverviewState; // 服务器资源概览（分路轮询写入）
    snapshotFn: Record<string, () => unknown>;
    snapshot: Record<string, unknown>;
}

export interface ChannelInstanceGroup {
    sessionId: string; // 分组ID
    instances: ChannelInstance[]; // 分组内的实例列表
    zindex: number; // 分组叠放层级（最近操作的分组更大）
}

export type ChannelData = ChannelInstance | ChannelInstanceGroup;

export function isChannelInstance(data: ChannelData): data is ChannelInstance {
    return "status" in data;
}

export function isChannelInstanceGroup(data: ChannelData): data is ChannelInstanceGroup {
    return "instances" in data;
}

function cloneChannelDataForNotify(data: ChannelData): ChannelData {
    if (isChannelInstanceGroup(data)) return { ...data, instances: [...data.instances] };
    return { ...data };
}

/**
 * ChannelInstance 会被终端、资源轮询等模块长期持有并原地更新。
 * Zustand 不会追踪这些嵌套字段变更，因此需要显式换外层引用，并让 selectSession 指向新对象。
 */
export function notifyChannelInstancesChanged(): void {
    const state = useChannelInstancesStore.getState();
    const instances = state.instances.map((item) => (item.sessionId === state.selectSessionId ? cloneChannelDataForNotify(item) : item));
    useChannelInstancesStore.setState({
        instances,
        selectSession: deriveSelectSession(instances, state.selectSessionId),
    });
}

/** 连接状态从 TermServer 侧变化时，统一通知依赖 selectSession / instances 的界面与轮询订阅。 */
export function setChannelInstanceStatus(instance: ChannelInstance, status: ChannelInstance["status"]): void {
    // TermServer 可能持有旧的 ChannelInstance 引用，不能只看入参状态就提前返回；
    // 必须按 sessionId 写回 Zustand 中的当前对象，否则概览轮询会一直认为会话未连接。
    instance.status = status;
    const state = useChannelInstancesStore.getState();
    let touched = false;
    const instances = state.instances.map((item) => {
        if (isChannelInstance(item) && item.sessionId === instance.sessionId) {
            touched = true;
            return { ...item, status };
        }
        if (isChannelInstanceGroup(item)) {
            let childTouched = false;
            const children = item.instances.map((child) => {
                if (child.sessionId !== instance.sessionId) return child;
                childTouched = true;
                return { ...child, status };
            });
            if (childTouched) {
                touched = true;
                return { ...item, instances: children };
            }
        }
        return item;
    });
    if (!touched) {
        notifyChannelInstancesChanged();
        return;
    }
    useChannelInstancesStore.setState({
        instances,
        selectSession: deriveSelectSession(instances, state.selectSessionId),
    });
}

type ChannelInstancesState = {
    instances: ChannelData[];
    selectSessionId: string;
    zindex: number;
    selectSession?: ChannelData;
    clear: () => void;
    add: (instance: ChannelData) => void;
    del: (instance: ChannelData) => void;
    reorder: (fromSessionId: string, toSessionId: string) => void;
    select: (instance: ChannelData) => void;
};

function deriveSelectSession(instances: ChannelData[], selectSessionId: string): ChannelData | undefined {
    return instances.find((i) => i.sessionId === selectSessionId);
}

export const useChannelInstancesStore = create<ChannelInstancesState>((set, get) => ({
    instances: [],
    selectSessionId: "1",
    zindex: 1,
    selectSession: undefined,
    clear() {
        set({ instances: [], selectSessionId: "", selectSession: undefined });
    },
    add(instance) {
        const current = get();
        if (current.instances.includes(instance)) return;
        if (isChannelInstance(instance) && !instance.overview) {
            instance.overview = createDefaultServerOverview();
        }
        instance.zindex = current.zindex;
        const instances = [...current.instances, instance];
        set({
            instances,
            selectSessionId: instance.sessionId,
            selectSession: instance,
            zindex: current.zindex + 1,
        });
    },
    del(instance) {
        const current = get();
        const index = current.instances.indexOf(instance);
        if (index < 0) return;
        const instances = current.instances.filter((item) => item !== instance);
        const selectSessionId = instance.sessionId === current.selectSessionId && instances.length > 0 ? instances[Math.min(instances.length - 1, index)].sessionId : current.selectSessionId;
        set({
            instances,
            selectSessionId,
            selectSession: deriveSelectSession(instances, selectSessionId),
        });
    },
    reorder(fromSessionId, toSessionId) {
        const current = get();
        const fromIndex = current.instances.findIndex((item) => item.sessionId === fromSessionId);
        const toIndex = current.instances.findIndex((item) => item.sessionId === toSessionId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
        const instances = [...current.instances];
        const [moved] = instances.splice(fromIndex, 1);
        instances.splice(toIndex, 0, moved);
        // Vue 版 vuedraggable 直接改 Pinia 数组；Zustand 需要换新数组才能通知 tab 视图重绘。
        set({ instances, selectSession: deriveSelectSession(instances, current.selectSessionId) });
    },
    select(instance) {
        const zindex = get().zindex;
        instance.zindex = zindex;
        set({ selectSessionId: instance.sessionId, selectSession: instance, zindex: zindex + 1 });
    },
}));

let channelInstancesInited = false;
let closeFuns: UnlistenFn[] = [];

/** 终端实例跨窗口事件在客户端注册一次，避免主窗口 StrictMode 双注册导致重复打开 tab。 */
export async function initChannelInstancesStore(): Promise<void> {
    if (channelInstancesInited || typeof window === "undefined") return;
    channelInstancesInited = true;
    const win = getCurrentWindow();
    closeFuns.push(
        await win.listen<ServerTreeClickServerPayload>(SERVER_TREE_CLICK_SERVER_EVENT, ({ payload }) => {
            const server = useServerDataStore.getState().findServerDataById(payload.id);
            if (!server) return;
            useChannelInstancesStore.getState().add({
                sessionId: uuid(),
                server,
                status: "disconnected",
                zindex: 0,
                snapshotFn: {},
                snapshot: {},
            });
            void useServerDataStore.getState().addRecentlyServerData(server);
        }),
    );
    closeFuns.push(
        await win.listen<ChannelInstanceGroupCreatePayload>(CHANNEL_INSTANCE_GROUP_CREATE_EVENT, ({ payload }) => {
            const instances = payload.ids
                .map((id) => useServerDataStore.getState().findServerDataById(id))
                .filter((server): server is ServerDataModel => Boolean(server))
                .map<ChannelInstance>((server) => ({
                    sessionId: uuid(),
                    server,
                    status: "disconnected",
                    zindex: 0,
                    snapshotFn: {},
                    snapshot: {},
                }));
            useChannelInstancesStore.getState().add({
                sessionId: uuid(),
                instances,
                zindex: 0,
            });
        }),
    );
    closeFuns.push(
        await win.listen<ChannelInstanceMoveToWindowPayload>(CHANNEL_INSTANCE_MOVE_TO_WINDOW_EVENT, ({ payload }) => {
            // 主窗口可能处在服务器列表页，tab 组件尚未挂载，因此移动接收必须放在 store 层。
            // 收到后先恢复 snapshot，再 add 到 store，Term 组件挂载时会消费这些快照。
            payload.instance.snapshot = payload.snapshot;
            useChannelInstancesStore.getState().add(payload.instance);
        }),
    );
}

export function disposeChannelInstancesStoreListeners(): void {
    closeFuns.forEach((unlisten) => unlisten());
    closeFuns = [];
    channelInstancesInited = false;
}
