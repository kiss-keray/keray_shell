<script setup lang="ts">
import { useServerOverviewPolling } from "@/composables/useServerOverviewPolling";

export type Tag = "system" | "process" | "net" | "disk"; // 面板标签

const props = withDefaults(
    defineProps<{
        instance: ChannelInstance;
        tags?: Tag[];
        onlyMount?: boolean;
        diskHeight?: number;
        diskFilter?: string;
    }>(),
    {
        tags: () => ["system", "process", "net", "disk"],
    },
);

const overview = computed(() => props.instance.overview);

useServerOverviewPolling(props.instance);
</script>

<template>
    <div class="overview-root">
        <template v-if="overview">
            <div v-if="overview.error" class="ov-err">{{ overview.error }}</div>
            <ServerMessage v-if="tags.includes('system')" :instance="instance" :only-mount="onlyMount" />
            <ServerProcess v-if="tags.includes('process')" :instance="instance" :only-mount="onlyMount" />
            <ServerNet v-if="tags.includes('net')" :instance="instance" :only-mount="onlyMount" />
            <ServerDisk v-if="tags.includes('disk')" :instance="instance" :only-mount="onlyMount" :disk-filter="diskFilter" :disk-height="diskHeight" />
        </template>
        <div v-else class="empty">暂无连接的服务器</div>
    </div>
</template>

<style scoped lang="scss">
.overview-root {
    flex: 1;
    min-height: 0;
    height: 100%;
    padding: 6px 0 10px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.disk-scroll-region {
    flex: 1 1 0;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    border-radius: 8px;
}

.ov-err {
    padding: 8px 10px;
    font-size: var(--font-size-xs);
    border-radius: 8px;
}

.empty {
    padding: 24px 12px;
    text-align: center;
    border-radius: 8px;
}
</style>
