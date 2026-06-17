<script setup lang="ts">
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { storeToRefs } from "pinia";
import type { MenuItem } from "@/components/DefaultMenuItems.vue";
import { CustomMenusEventKey } from "@/utils/constant";
import { openOrFocusChildWindow } from "@/utils/window";
import { CHANNEL_INSTANCE_MOVE_TO_WINDOW_EVENT, isChannelInstance, isChannelInstanceGroup, type ChannelData, type ChannelInstance } from "@/stores/channelInstances";
import Draggable from "vuedraggable";
const appWindow = getCurrentWindow();
const appStore = useAppStore();
const { windowInitData } = toRefs(appStore) as { windowInitData: Ref<ChannelInstanceMoveToWindowPayload>; mainLabel: Ref<string | null> };
const { mainLabel, isMainWin } = toRefs(appStore);

const root = ref();
const left = ref(0);

const dragsPosition: {
    x: number;
    y: number;
    data: ChannelInstanceMoveToWindowPayload | null;
} = {
    x: -1,
    y: -1,
    data: null,
};

const channelInstancesStore = useChannelInstancesStore();
const { isFullScreenWindow } = storeToRefs(appStore);

const instances = computed(() => channelInstancesStore.instances);
const selectUid = computed(() => channelInstancesStore.selectSessionId);
let dragPayload: ChannelInstanceMoveToWindowPayload | null = null; // 当前拖动tab的数据
let dragOverOtherWindow = false; // 是否拖动到其他窗口 在其他窗口时释放时不创建新窗口

/** 子窗口移走/关闭最后一个 tab 后自动关闭；主窗口即使空了也要留下来显示服务器列表。 */
async function closeWindowIfEmpty() {
    if (channelInstancesStore.instances.length > 0) return;
    if (isMainWin.value) return;
    // 非主窗口关闭时 销毁当前窗口
    void appWindow.destroy();
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
        window: appWindow.label,
    };
}

async function moveToNewWindow(item: ChannelData) {
    // 新窗口只支持单个普通终端 tab；当前窗口只有一个 tab 时保持原有行为，不再拆出新窗口。
    if (!isChannelInstance(item) || channelInstancesStore.instances.length <= 1) return;
    const payload = createMovePayload(item);
    const position = await appWindow.outerPosition();
    // 先从当前窗口移除，再创建子窗口，避免同一个 session 同时出现在两个窗口里。
    channelInstancesStore.del(item);
    openOrFocusChildWindow(item, {
        x: position.x / appStore.scaleFactor + 32,
        y: position.y / appStore.scaleFactor + 32,
        width: document.body.clientWidth,
        height: document.body.clientHeight,
        fullscreen: isFullScreenWindow.value,
        ...payload,
    });
    closeWindowIfEmpty();
}

async function mergeToMainWindow(item: ChannelData) {
    // 已经在主窗口时不需要融合；融合终端组暂不拆组移动，避免组内布局和 session 关系丢失。
    if (!mainLabel.value || mainLabel.value === appWindow.label || !isChannelInstance(item)) return;
    const payload = createMovePayload(item);
    await emitTo<ChannelInstanceMoveToWindowPayload>({ kind: "Window", label: mainLabel.value }, CHANNEL_INSTANCE_MOVE_TO_WINDOW_EVENT, payload);
    // 主窗口确认接收事件后，再从当前窗口删除 tab。
    channelInstancesStore.del(item);
    closeWindowIfEmpty();
}

watch(windowInitData, (initData) => {
    if (isMainWin.value) return;
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

/** 批量关闭 tab，并在子窗口被清空时同步销毁窗口。 */
function closeInstances(items: ChannelData[]) {
    items.forEach((item) => {
        channelInstancesStore.del(item);
        /** 关闭 tab 对应的后端终端；融合终端需要逐个关闭组内 session。 */
        if (isChannelInstance(item)) {
            void invoke("close_term", { sid: item.sessionId });
            return;
        }
        item.instances.forEach((instance) => {
            void invoke("close_term", { sid: instance.sessionId });
        });
    });
    closeWindowIfEmpty();
}

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
    dragsPosition.data = createMovePayload(item);
    // 开始拖动时向所有窗口通知拖动开始的事件
    emitTo<ChannelInstanceMoveToWindowPayload>({ kind: "Any" }, "sid_new_window_dragstart", dragsPosition.data);
};

const dragend = async (e: DragEvent, item: ChannelData) => {
    if (!isChannelInstance(item)) return;
    emitTo<string>({ kind: "Any" }, "sid_new_window_dragend", appWindow.label);
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
        const { x, y } = await appWindow.outerPosition();
        const left = x / appStore.scaleFactor + rect.left;
        const top = y / appStore.scaleFactor + rect.top;
        if (screenX > left && screenX < left + rect.width && screenY > top && screenY < top + rect.height) {
            return;
        }
    }
    // 只有一个的拖动  只改变窗口位置
    if (channelInstancesStore.instances.length === 1) {
        await appWindow.setPosition(new LogicalPosition(endx, endy));
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
    closeWindowIfEmpty();
};

const dragOk = (payload: ChannelInstanceMoveToWindowPayload) => {
    const server = payload.instance;
    server.snapshot = payload.snapshot;
    channelInstancesStore.add(server);
};

function openContextMenu(e: MouseEvent, item: ChannelData) {
    e.preventDefault();
    e.stopPropagation();
    // 右键菜单沿用全局 CustomMenusEventKey，由 App.vue 统一渲染，风格与服务器树/SFTP 一致。
    const menus: MenuItem[] = [
        {
            label: "关闭",
            handler: () => closeInstances([item]),
        },
        {
            label: "关闭其他",
            disabled: instances.value.length <= 1,
            handler: () => closeInstances(instances.value.filter((v) => v !== item)),
        },
        {
            label: "关闭全部",
            handler: () => closeInstances([...instances.value]),
        },
        "---",
        {
            label: "新窗口",
            // 按需求：当前窗口必须至少还有其他 tab，才允许把当前 tab 拆到新窗口。
            disabled: !isChannelInstance(item) || instances.value.length <= 1,
            handler: () => {
                void moveToNewWindow(item);
            },
        },
        {
            label: "融合到主窗口",
            // 按需求：当前窗口不是主窗口时才显示为可操作，避免主窗口融合到自己。
            disabled: !isChannelInstance(item) || isMainWin.value,
            handler: () => {
                void mergeToMainWindow(item);
            },
        },
    ];
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
}

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
    if (!isMainWin.value && windowInitData.value) {
        dragOk(windowInitData.value);
    }
});

onUnmounted(() => {
    closeFuns.forEach((unlisten) => unlisten());
});

// 拖动开始时将数据保存
appWindow
    .listen<ChannelInstanceMoveToWindowPayload>("sid_new_window_dragstart", ({ payload }) => {
        if (payload.window === appWindow.label) return;
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
    .listen<ChannelInstanceMoveToWindowPayload>("sid_new_window_ok", ({ payload }) => {
        const instance = payload.instance;
        const item = instances.value.find((v) => v.sessionId === instance.sessionId);
        channelInstancesStore.del(item!);
        closeWindowIfEmpty();
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
appWindow
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
                    @contextmenu="(e) => openContextMenu(e, item)"
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
                        @click.stop="closeInstances([item])"
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
