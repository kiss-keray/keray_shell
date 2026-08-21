<script setup lang="ts">
import type { CommandResultStatus } from "@/agent/graph/tools";
import type { CommandQueueItem } from "@/agent/types";

/**
 * exec_command 工具下发的命令队列面板，展示在输入框上方。
 * 每行对应 CommandQueueItem：状态图标 + 命令内容 + 耗时；面板整体可折叠。
 */
defineOptions({ name: "AgentCommandQueue" });

const props = defineProps<{ items: CommandQueueItem[] }>();

/** 折叠状态由用户手动控制，默认展开以便观察正在执行的命令。 */
const collapsed = ref(false);

const hasRunning = computed(() => props.items.some((item) => item.status === "running"));

/**
 * 复制后倒序，避免修改 props 及命令的实际执行顺序。
 * 最后加入（最后执行）的命令显示在列表最前面。
 */
const displayedItems = computed(() => [...props.items].reverse());

/**
 * 工具侧只在命令结束的 finally 里回填 useTimeMs，运行期间恒为 0；
 * 因此运行中的耗时以前端首次看到该命令的时间为起点，由计时器驱动实时走动。
 */
const startTimes = new Map<string, number>();
const now = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | undefined;

// 有运行中的命令才启动计时器，全部结束后立即停表，避免面板空转刷新。
watch(
    hasRunning,
    (running) => {
        if (running && !tickTimer) {
            tickTimer = setInterval(() => (now.value = Date.now()), 100);
        } else if (!running && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = undefined;
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => clearInterval(tickTimer));

/** 运行中取前端实时耗时；结束后用工具侧回填的真实耗时，更准。 */
function elapsedMs(item: CommandQueueItem): number {
    if (item.status !== "running") return item.useTimeMs;
    let start = startTimes.get(item.id);
    if (!start) {
        start = Date.now();
        startTimes.set(item.id, start);
    }
    return Math.max(0, now.value - start);
}

/** 1 分钟内保留一位小数的秒数（0.7s），超过后按「分:秒」展示（1m 05s）。 */
function formatDuration(ms: number): string {
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const totalSeconds = Math.floor(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

const STATUS_META: Record<CommandResultStatus, { icon: string; label: string }> = {
    running: { icon: "mdi:loading", label: "执行中" },
    success: { icon: "mdi:check-circle", label: "执行成功" },
    error: { icon: "mdi:close-circle", label: "执行失败" },
    cancelled: { icon: "mdi:stop-circle", label: "已停止" },
    partial_success: { icon: "mdi:alert-circle", label: "部分执行成功" },
} as const;
</script>

<template>
    <div v-if="items.length" class="agent-command-queue">
        <!-- 头部整行都是折叠开关；收起后仍保留条数徽标，提示队列规模。 -->
        <button
            type="button"
            class="agent-command-queue-header"
            :aria-expanded="!collapsed"
            :title="collapsed ? '展开命令队列' : '收起命令队列'"
            @click="collapsed = !collapsed"
        >
            <span class="agent-command-queue-title">命令队列</span>
            <span class="agent-command-queue-count">{{ items.length }}</span>
            <Icon class="agent-command-queue-toggle" :icon="collapsed ? 'mdi:chevron-up' : 'mdi:chevron-down'" />
        </button>
        <ul v-show="!collapsed" class="agent-command-queue-list">
            <li v-for="item in displayedItems" :key="item.id" class="agent-command-queue-item" :class="`is-${item.status}`">
                <Icon
                    class="agent-command-queue-status"
                    :class="{ 'app-loading-spin': item.status === 'running' }"
                    :icon="STATUS_META[item.status].icon"
                    :title="STATUS_META[item.status].label"
                />
                <span class="agent-command-queue-data" :title="item.data">{{ item.data }}</span>
                <span class="agent-command-queue-time">{{ formatDuration(elapsedMs(item)) }}</span>
            </li>
        </ul>
    </div>
</template>

<style scoped lang="scss">
/* 只放布局样式；颜色、边框、阴影等主题相关样式在 theme.*.scss 的 .agent-command-queue 中。 */
.agent-command-queue {
    margin-bottom: 8px;
    border-radius: 12px;
    overflow: hidden;
    font-size: var(--font-size-sm);
}
.agent-command-queue-header {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1.4;
}
.agent-command-queue-count {
    min-width: 20px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: var(--font-size-xs);
    line-height: 1.6;
    text-align: center;
}
.agent-command-queue-toggle {
    margin-left: auto;
    font-size: 16px;
}
/* 列表限高滚动，避免长队列把输入框顶出可视区。 */
.agent-command-queue-list {
    max-height: 168px;
    margin: 0;
    padding: 0 12px 8px;
    overflow-y: auto;
    list-style: none;
}
.agent-command-queue-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
}
.agent-command-queue-status {
    flex: none;
    font-size: 15px;
}
.agent-command-queue-data {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: var(--font-size-xs);
}
.agent-command-queue-time {
    flex: none;
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
}
</style>
