<script setup lang="ts">
import { ActiveFileEventKey, DirectRemotePathEventKey, useBus } from "@/composables/useBus";
const props = defineProps<{
    instance: ChannelInstance;
    onlyMount?: boolean;
    diskHeight?: number;
    diskFilter?: string;
}>();

const { emit, on, off } = useBus();

const overview = computed(() => props.instance?.overview);

const activePath = ref("/");

const activeDisk = computed(() => {
    const disks = overview.value?.disks;
    if (!disks) return undefined;
    if (activePath.value === "/") {
        return disks.find((d) => d.path === "/");
    }
    const matchDisks = disks.filter((d) => activePath.value.startsWith(d.path));
    return matchDisks.sort((a, b) => b.path.length - a.path.length)[0];
});

const showDisk = computed(() => {
    /**
     * 将简单通配表达式转成 RegExp。
     * 规则：
     * - "*" 匹配任意字符串，包括空字符串
     * - 其它字符都按字面量匹配，避免被正则特殊字符影响
     */
    function patternToRegExp(pattern: string): RegExp {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        // 将通配符 * 转成正则的任意字符匹配
        const regex = escaped.replace(/\*/g, ".*");
        // ^ 和 $ 保证整个字符串完整匹配，而不是局部命中
        return new RegExp(`^${regex}$`);
    }
    return (overview.value?.disks || [])
        .filter((d) => {
            if (!props.diskFilter) return true;
            return patternToRegExp(props.diskFilter).test(d.path);
        })
        .sort((a, b) => a.path.localeCompare(b.path));
});

function onActiveDisk(path: string) {
    activePath.value = path;
    emit(DirectRemotePathEventKey, { sid: props.instance.sessionId, path: activePath.value });
}

function handleActiveFile(event: { sid: string; path: string }) {
    if (event.sid !== props.instance?.sessionId) return;
    activePath.value = event.path;
}

onMounted(() => {
    on(ActiveFileEventKey, handleActiveFile);
});

onUnmounted(() => {
    off(ActiveFileEventKey, handleActiveFile);
});
</script>

<template>
    <div class="module disk" :style="{ height: diskHeight + 'px' }">
        <table class="tbl disk">
            <thead>
                <tr>
                    <th>路径</th>
                    <th>可用/大小</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="(d, i) in showDisk" :key="i" :class="{ root: d === activeDisk }" @click="onActiveDisk(d.path)">
                    <td class="path">{{ d.path }}</td>
                    <td class="disk-cell">
                        <div class="disk-bar" :style="{ width: d.pct + '%' }" />
                        <span class="disk-txt">{{ d.avail }}/{{ d.size }}</span>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style scoped lang="scss">
.disk {
    padding: 10px 12px;
    line-height: 1.35;
    border-radius: 8px;
    overflow: auto;
}

.tbl {
    width: 100%;
    border-collapse: collapse;
    margin: 0;
    table-layout: fixed;
}

.tbl.disk thead {
}

.tbl.disk th {
    font-weight: 600;
    padding: 5px 6px;
    text-align: left;
    font-size: var(--font-size-xs);
}

.tbl.disk td {
    padding: 5px 6px;
    font-size: var(--font-size-xs);
    border-bottom: 1px solid rgba(0, 0, 0, 0.2);
    vertical-align: middle;
}

.tbl.disk .path {
    word-break: break-all;
}

.disk-cell {
    position: relative;
    min-width: 88px;
}

.disk-bar {
    position: absolute;
    left: 0;
    top: 3px;
    bottom: 3px;
    max-width: calc(100% - 4px);
    border-radius: 4px;
    pointer-events: none;
}

.disk-txt {
    position: relative;
    z-index: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
</style>
