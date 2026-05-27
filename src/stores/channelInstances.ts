import { getCurrentWindow } from "@tauri-apps/api/window";
import { computed, ref, type Ref } from "vue";
import { defineStore } from "pinia";
import type { ServerDataModel, ServerRustModel } from "./serverData";
import type { UnlistenFn } from "@tauri-apps/api/event";

export const SERVER_TREE_CLICK_SERVER_EVENT = "server_tree_click_server";

export type ServerTreeClickServerPayload = {
    id: string;
};

export const CHANNEL_INSTANCE_GROUP_CREATE_EVENT = "channel_instance_group_create";

export type ChannelInstanceGroupCreatePayload = {
    ids: string[];
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

export const useChannelInstancesStore = defineStore("channelInstances", () => {
    const closeFuns: UnlistenFn[] = [];
    const serverDataStore = useServerDataStore();
    const instances: Ref<ChannelData[]> = ref([]);
    const selectSessionId: Ref<string> = ref("1");
    const zindex: Ref<number> = ref(1);

    /** 当前选中的会话对象，便于组件直接绑定 */
    const selectSession = computed<ChannelData | undefined>(() => {
        return instances.value.find((i) => i.sessionId === selectSessionId.value);
    });

    /** 清空所有实例与选中态（例如登出或重置工作区） */
    function clear() {
        instances.value = [];
        selectSessionId.value = "";
    }

    /** 添加实例并选中新会话；若无 overview 则挂一份默认状态 */
    function add(instance: ChannelData) {
        if (instances.value.includes(instance)) return;
        if (isChannelInstance(instance) && !instance.overview) {
            instance.overview = createDefaultServerOverview();
        }
        instances.value.push(instance);
        selectSessionId.value = instance.sessionId;
        instance.zindex = zindex.value++;
    }

    function del(instance: ChannelData) {
        const index = instances.value.indexOf(instance);
        instances.value.splice(index, 1);
        if (instance.sessionId === selectSessionId.value && instances.value.length > 0) {
            const newIndex = Math.min(instances.value.length - 1, index);
            selectSessionId.value = instances.value[newIndex].sessionId;
        }
    }

    function select(instance: ChannelData) {
        selectSessionId.value = instance.sessionId;
        instance.zindex = zindex.value++;
    }

    getCurrentWindow()
        .listen<ServerTreeClickServerPayload>(SERVER_TREE_CLICK_SERVER_EVENT, ({ payload }) => {
            const server = serverDataStore.findServerDataById(payload.id);
            if (server) {
                add({
                    sessionId: uuid(),
                    server,
                    status: "disconnected",
                    zindex: 0,
                    snapshotFn: {},
                    snapshot: {},
                });
                serverDataStore.addRecentlyServerData(server);
            }
        })
        .then((unlisten) => {
            closeFuns.push(unlisten);
        });
    getCurrentWindow()
        .listen<ChannelInstanceGroupCreatePayload>(CHANNEL_INSTANCE_GROUP_CREATE_EVENT, ({ payload }) => {
            const instances = payload.ids.map((id) => {
                const server = serverDataStore.findServerDataById(id);
                const instance: ChannelInstance = {
                    sessionId: uuid(),
                    server: server!,
                    status: "disconnected",
                    zindex: 0,
                    snapshotFn: {},
                    snapshot: {},
                };
                return instance;
            });
            const group: ChannelInstanceGroup = {
                sessionId: uuid(),
                instances,
                zindex: 0,
            };
            add(group);
        })
        .then((unlisten) => {
            closeFuns.push(unlisten);
        });

    onUnmounted(() => {
        closeFuns.forEach((unlisten) => unlisten());
    });

    return {
        instances,
        selectSessionId,
        zindex,
        selectSession,
        clear,
        add,
        del,
        select,
    };
});
