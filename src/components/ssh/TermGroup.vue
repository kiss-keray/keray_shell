<script setup lang="ts">
import type { ChannelInstance, ChannelInstanceGroup } from "@/stores/channelInstances";
import { GroupLayout, type LayoutRect } from "./term_grpup";
import { TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const props = defineProps<{
    group: ChannelInstanceGroup;
}>();

const channelInstancesStore = useChannelInstancesStore();
const container = ref<HTMLElement | null>(null);
const layoutMap = ref<Record<string, LayoutRect>>({});
const selectTermId = ref<string | null>(null);
let groupLayoutInstance: GroupLayout | null = null;

const closeFuns: UnlistenFn[] = [];

watch(selectTermId, (val) => {
    if (!val) return;
    const ow = container.value!.clientWidth;
    const oh = container.value!.clientHeight;
    const layouts = groupLayoutInstance?.changeSelectedBoxId(val, ow, oh);
    updateLayout(layouts);
});

function updateLayout(layouts: LayoutRect[] | undefined) {
    if (!layouts) return;
    layoutMap.value = layouts.reduce(
        (acc, layout) => {
            acc[layout.id] = layout;
            return acc;
        },
        {} as Record<string, LayoutRect>,
    );
}

function initLayout() {
    const ow = container.value!.clientWidth;
    const oh = container.value!.clientHeight;
    groupLayoutInstance = new GroupLayout({
        selectedBoxId: selectTermId.value!,
        targetLandscapeRatio: 1.2,
        expandedWidth: ow / 2,
        expandedHeight: (ow / 2) * 0.8,
    });
    const layouts = groupLayoutInstance.layoutInit(props.group.instances, ow, oh);
    updateLayout(layouts);
}

function closeInstance(item: ChannelInstance) {
    invoke("close_term", { sid: item.sessionId });
    props.group.instances.remove(item);
    if (props.group.instances.length === 0) {
        channelInstancesStore.del(props.group);
        return;
    }
    if (item.sessionId === selectTermId.value) {
        selectTermId.value = props.group.instances[0].sessionId;
    }
    initLayout();
}

onMounted(async () => {
    selectTermId.value = props.group.instances[0].sessionId;
    initLayout();
    getCurrentWindow()
        .listen(TauriEvent.WINDOW_RESIZED, initLayout)
        .then((unlisten) => {
            closeFuns.push(unlisten);
        });
});

onUnmounted(() => {
    closeFuns.forEach((unlisten) => unlisten());
});

function statusLabel(status: ChannelInstance["status"]) {
    if (status === "connected") return "已连接";
    if (status === "connecting") return "连接中";
    return "未连接";
}
</script>

<template>
    <div ref="container" class="term-group">
        <div
            v-for="instance in group.instances"
            :key="instance.sessionId"
            :style="{
                left: layoutMap[instance.sessionId]?.x + 'px',
                top: layoutMap[instance.sessionId]?.y + 'px',
                width: layoutMap[instance.sessionId]?.width + 'px',
                height: layoutMap[instance.sessionId]?.height + 'px',
            }"
            class="child-box"
            :class="{ active: selectTermId === instance.sessionId }"
            @click="selectTermId = instance.sessionId"
        >
            <div class="child-box-header" :title="`${instance.server.name} · ${instance.server.user}@${instance.server.ip}:${instance.server.port}`">
                <div class="child-box-name">{{ instance.server.name }}</div>
                <div class="child-box-meta">{{ instance.server.user }}@{{ instance.server.ip }}:{{ instance.server.port }}</div>
                <div class="child-box-status" :class="instance.status">
                    <i class="child-box-status-dot" aria-hidden="true" />
                    {{ statusLabel(instance.status) }}
                </div>
                <Icon icon="si:close-duotone" class="pointer icon" @click.stop="closeInstance(instance)" />
            </div>
            <Term :server="instance" :group-id="group.sessionId" :group-active="selectTermId === instance.sessionId" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.term-group {
    width: 100vw;
    height: 100vh;
    position: relative;
    :deep(.child-box) {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        transition:
            left 0.35s ease,
            top 0.35s ease,
            width 0.35s ease,
            height 0.35s ease,
            box-shadow 0.35s ease,
            transform 0.35s ease;
        overflow: hidden;

        .child-box-header {
            display: flex;
            flex-direction: row;
            align-items: center;
            padding: 6px 6px;
            > div {
                margin: 0 10px;
            }

            .child-box-name {
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .child-box-meta {
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 10px;
                font-weight: 400;
            }

            .child-box-status {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                font-weight: 500;
            }

            .child-box-status-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: currentColor;
            }
        }

        .term-module {
            border-radius: 0;
            .term {
                height: 95%;
            }
        }
    }
}
</style>
