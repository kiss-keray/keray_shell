<script setup lang="ts">
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { storeToRefs } from "pinia";
import { openOrFocusChildWindow } from "@/utils/window";
import { isChannelInstance, isChannelInstanceGroup, type ChannelData, type ChannelInstance } from "@/stores/channelInstances";
import Draggable from "vuedraggable";
const appWindow = getCurrentWindow();
export type DragStartPayload = {
    window: string;
    instance: ChannelInstance;
    snapshot: Record<string, unknown>;
};

const appStore = useAppStore();
const { appType } = appStore;
const { windowInitData } = toRefs(appStore) as { windowInitData: Ref<DragStartPayload> };

const root = ref();
const left = ref(0);

const dragsPosition: {
    x: number;
    y: number;
    data: DragStartPayload | null;
} = {
    x: -1,
    y: -1,
    data: null,
};

const channelInstancesStore = useChannelInstancesStore();
const { isFullScreenWindow } = storeToRefs(appStore);

const instances = computed(() => channelInstancesStore.instances);
const selectUid = computed(() => channelInstancesStore.selectSessionId);
let dragPayload: DragStartPayload | null = null; // 当前拖动tab的数据
let dragOverOtherWindow = false; // 是否拖动到其他窗口 在其他窗口时释放时不创建新窗口

watch(windowInitData, (initData) => {
    if (appType !== "child") return;
    if (!initData) return;
    dragOk(initData);
});

watch(isFullScreenWindow, (val) => {
    if (val) {
        left.value = 0;
    } else {
        const rect = root.value.getBoundingClientRect();
        left.value = Math.max(0, 80 - rect.left - window.scrollX);
    }
});

const closeInstance = (item: ChannelData) => {
    if (isChannelInstance(item)) {
        invoke("close_term", { sid: item.sessionId });
    } else {
        item.instances.forEach((instance) => {
            invoke("close_term", { sid: instance.sessionId });
        });
    }
    channelInstancesStore.del(item);
};

const selectInstance = async (item: ChannelData) => {
    channelInstancesStore.select(item);
};

const setDragData = (dataTransfer: DataTransfer) => {
    dataTransfer.clearData();
    dataTransfer.effectAllowed = "move";
    dataTransfer.setData("application/x-keray-shell-tab", "");
};

const dragstart = async (e: DragEvent, item: ChannelData) => {
    if (!isChannelInstance(item)) return;
    e.dataTransfer?.clearData();
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    e.dataTransfer?.setData("application/x-keray-shell-tab", item.sessionId);
    // 计算新窗口位置
    dragsPosition.x = e.screenX;
    dragsPosition.y = e.screenY;
    dragOverOtherWindow = false;
    const fnMap = item.snapshotFn;
    const snapshot = Object.entries(fnMap).reduce(
        (acc, [key, fn]) => {
            acc[key] = fn();
            return acc;
        },
        {} as Record<string, unknown>,
    );
    dragsPosition.data = {
        instance: { ...item, snapshotFn: {} },
        snapshot: snapshot,
        window: getCurrentWindow().label,
    };
    // 开始拖动时向所有窗口通知拖动开始的事件
    emitTo<DragStartPayload>({ kind: "Any" }, "sid_new_window_dragstart", dragsPosition.data);
};

const dragend = async (e: DragEvent, item: ChannelData) => {
    if (!isChannelInstance(item)) return;
    emitTo<string>({ kind: "Any" }, "sid_new_window_dragend", getCurrentWindow().label);
    if (dragsPosition.x < 0) return;
    const { screenX, screenY } = e;
    if (Math.abs(dragsPosition.x - screenX) < 50 && Math.abs(dragsPosition.y - screenY) < 50) {
        // 小拖动不处理
        return;
    }
    const rect = root.value.getBoundingClientRect();
    const endx = screenX - appStore.safeLeft - rect.x - 20; // 20px误差
    const endy = screenY - appStore.safeTop;
    // end时判断鼠标是否在root范围内，不在时才表示新开窗口
    {
        const win = getCurrentWindow();
        const { x, y } = await win.outerPosition();
        const left = x / appStore.scaleFactor + rect.left;
        const top = y / appStore.scaleFactor + rect.top;
        if (screenX > left && screenX < left + rect.width && screenY > top && screenY < top + rect.height) {
            return;
        }
    }
    // 只有一个的拖动  只改变窗口位置
    if (channelInstancesStore.instances.length === 1) {
        await getCurrentWindow().setPosition(new LogicalPosition(endx, endy));
        return;
    }
    if (dragOverOtherWindow) return;
    channelInstancesStore.del(item);
    const payload = dragsPosition.data;
    openOrFocusChildWindow(item, {
        x: endx,
        y: endy,
        width: document.body.clientWidth,
        height: document.body.clientHeight,
        fullscreen: isFullScreenWindow.value,
        ...payload!,
    });
    // 移动后本窗口没得数据就关闭窗口  如果是主窗口
    if (!channelInstancesStore.instances.length) {
        await getCurrentWindow().destroy();
    }
};

const dragOk = (payload: DragStartPayload) => {
    const server = payload.instance;
    server.snapshot = payload.snapshot;
    channelInstancesStore.add(server);
};

const closeFuns: UnlistenFn[] = [];

onMounted(async () => {
    const rect = root.value.getBoundingClientRect();
    left.value = Math.max(0, 80 - rect.left - window.scrollX);
    if (isFullScreenWindow.value) {
        left.value = 0;
    }
    const observer = new ResizeObserver(() => {
        const rect = root.value.getBoundingClientRect();
        left.value = Math.max(0, 80 - rect.left - window.scrollX);
        if (isFullScreenWindow.value) {
            left.value = 0;
        }
    });
    observer.observe(root.value);
    if (appType === "child" && windowInitData.value) {
        dragOk(windowInitData.value);
    }
});

onUnmounted(() => {
    closeFuns.forEach((unlisten) => unlisten());
});

// 拖动开始时将数据保存
appWindow
    .listen<DragStartPayload>("sid_new_window_dragstart", ({ payload }) => {
        if (payload.window === getCurrentWindow().label) return;
        dragPayload = payload;
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });

// 拖动放释放后将数据清空
appWindow
    .listen<string>("sid_new_window_dragend", ({ payload: label }) => {
        // 延迟执行 防止sid_new_window_dragend数据先于getCurrentWindow()的drop事件之前执行
        setTimeout(() => {
            if (dragPayload && dragPayload.window === label) {
                dragPayload = null;
            }
        }, 200);
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });

// 其他窗口通知进入他的窗口
appWindow
    .listen("sid_new_window_drags_enter", () => {
        dragOverOtherWindow = true;
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });

// 其他窗口通知离开他的窗口
appWindow
    .listen("sid_new_window_drags_leave", () => {
        dragOverOtherWindow = false;
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });

appWindow
    .listen<DragStartPayload>("sid_new_window_ok", ({ payload }) => {
        const instance = payload.instance;
        const item = instances.value.find((v) => v.sessionId === instance.sessionId);
        channelInstancesStore.del(item!);
        // 移动后本窗口没得数据就关闭窗口  如果是主窗口
        if (!channelInstancesStore.instances.length) {
            getCurrentWindow().destroy();
        }
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });

dragListener(() => {
    return Array.from(root.value?.querySelectorAll(".item") ?? []);
}).then((unlisten) => {
    closeFuns.push(unlisten);
});
// 将窗口拖回来
getCurrentWindow()
    .onDragDropEvent((event) => {
        if (!dragPayload) return;
        // 拖动到当前窗口上方
        if (event.payload.type === "over") {
            emitTo(
                {
                    kind: "Window",
                    label: dragPayload.window,
                },
                "sid_new_window_drags_enter",
            );
        }
        // 外边拖进来并释放了鼠标
        else if (event.payload.type === "drop") {
            // 拖动进来
            emitTo(
                {
                    kind: "Window",
                    label: dragPayload.window,
                },
                "sid_new_window_ok",
                dragPayload,
            );
            dragOk(dragPayload);
            dragPayload = null;
        }
        // 进入窗口
        else if (event.payload.type === "enter") {
            emitTo(
                {
                    kind: "Window",
                    label: dragPayload.window,
                },
                "sid_new_window_drags_enter",
            );
        }
        // 离开窗口
        else if (event.payload.type === "leave") {
            emitTo(
                {
                    kind: "Window",
                    label: dragPayload.window,
                },
                "sid_new_window_drags_leave",
            );
        }
    })
    .then((unlisten) => {
        closeFuns.push(unlisten);
    });
</script>

<template>
    <div ref="root" class="module servers" data-tauri-drag-region>
        <div :style="{ width: left + 'px' }"></div>
        <Draggable :list="channelInstancesStore.instances" item-key="sessionId" tag="div" class="tab-list" :animation="150" :set-data="setDragData">
            <template #item="{ element: item }: { element: ChannelData }">
                <div
                    class="item"
                    draggable="true"
                    v-sclick="() => selectInstance(item)"
                    :class="{ active: item.sessionId === selectUid }"
                    @dragstart="(e) => dragstart(e, item)"
                    @dragend="(e) => dragend(e, item)"
                >
                    <p v-if="isChannelInstance(item)">{{ item.server.name }}</p>
                    <p v-else>融合终端(+{{ item.instances.length }})</p>
                    <div
                        class="status xy-center"
                        :class="{
                            dis: isChannelInstance(item) && item.status === 'disconnected',
                            connect: isChannelInstanceGroup(item) || item.status === 'connected',
                            active: item.sessionId === selectUid,
                        }"
                        @click.stop="closeInstance(item)"
                    >
                        <Icon icon="si:close-duotone" class="pointer icon hidden" />
                    </div>
                </div>
            </template>
        </Draggable>
    </div>
</template>

<style scoped lang="scss">
.servers {
    display: flex;
    flex-wrap: wrap;

    .tab-list {
        display: flex;
        flex: 1;
        flex-wrap: wrap;
        min-width: 0;
        pointer-events: none;
    }

    .item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: default;
        height: 20px;
        margin: 4px;
        padding: 0 8px;
        border-radius: 20px;
        pointer-events: auto;
        user-select: none;
        -webkit-user-select: none;

        .status {
            width: 12px;
            height: 12px;
            border-radius: 100%;
            margin-left: 10px;
            &:hover {
                .icon {
                    display: block;
                }
            }
        }
    }
}
</style>
