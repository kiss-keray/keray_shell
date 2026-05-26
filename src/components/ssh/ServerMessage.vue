<script setup lang="ts">
const { selectSession } = toRefs(useChannelInstancesStore());

const metrics = computed(() => {
    const o = selectSession.value?.overview;
    if (!o) {
        return {
            uptimeDays: 0,
            load: "-",
            cpuPct: 0,
            mem: { used: 0, total: 0, pct: 0 },
            swap: { used: 0, total: 0, pct: 0 },
        };
    }
    return {
        uptimeDays: o.uptimeDays,
        load: o.load,
        cpuPct: o.cpuPct,
        mem: o.mem,
        swap: o.swap,
    };
});

const syncLabel = computed(() => {
    const s = selectSession.value?.status;
    if (s === "connected") return "已连接";
    if (s === "disconnected") return "已断开";
    return "未连接";
});

const syncClass = computed(() => {
    const s = selectSession.value?.status;
    if (s === "connected") return "ok";
    if (s === "disconnected") return "bad";
    return "idle";
});

async function copyIp() {
    const ip = selectSession.value?.server.ip;
    if (!ip) return;
    try {
        await navigator.clipboard.writeText(ip);
        showToast("复制成功", "success");
    } catch {
        // ignore
    }
}
</script>

<template>
    <div class="module message">
        <div data-tauri-drag-region="" class="row sync">
            <span class="sync-txt">同步状态</span>
            <span class="sync-dot" :class="syncClass" :title="syncLabel" />
        </div>
        <div class="row ip-row">
            <span class="ip-label">IP {{ selectSession?.server.ip }}</span>
            <button type="button" class="btn-copy" @click="copyIp">复制</button>
        </div>

        <div class="banner">系统信息</div>

        <div class="metric-line">运行 {{ metrics.uptimeDays }} 天</div>
        <div class="metric-line">负载 {{ metrics.load }}</div>

        <div class="bar-row">
            <span class="bar-label">CPU</span>
            <div class="bar-track">
                <div class="bar-fill cpu" :style="{ width: metrics.cpuPct + '%' }" />
                <span class="bar-inlabel">{{ metrics.cpuPct }}%</span>
            </div>
        </div>
        <div class="bar-row">
            <span class="bar-label">内存</span>
            <div class="bar-track">
                <div class="bar-fill mem" :style="{ width: metrics.mem.pct + '%' }" />
                <span class="bar-right">{{ metrics.mem.used }}/{{ metrics.mem.total }}</span>
            </div>
        </div>
        <div class="bar-row">
            <span class="bar-label">交换</span>
            <div class="bar-track">
                <div class="bar-fill swap" :style="{ width: metrics.swap.pct + '%' }" />
                <span class="bar-right">{{ metrics.swap.used }}/{{ metrics.swap.total }}</span>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.message {
    padding: 0 12px 10px;
    line-height: 1.35;
    border-radius: 8px;
}

.row {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
}

.sync {
    gap: 6px;
    height: 22px;
    justify-content: flex-end;
}

.sync-txt {
}

.sync-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.ip-row {
    justify-content: space-between;
    gap: 8px;
}

.ip-label {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.btn-copy {
    flex-shrink: 0;
    font-size: var(--font-size-xs);
    padding: 3px 10px;
    border-radius: 6px;
    cursor: pointer;

    &:hover {
    }
}

.banner {
    text-align: center;
    font-weight: 600;
    padding: 6px 0;
    margin: 8px 0 10px;
    letter-spacing: 0.02em;
}

.metric-line {
    margin-bottom: 5px;
}

.bar-row {
    display: flex;
    align-items: center;
    margin-bottom: 7px;
    gap: 8px;
}

.bar-label {
    width: 2.2em;
    flex-shrink: 0;
}

.bar-track {
    flex: 1;
    position: relative;
    height: 18px;
    overflow: hidden;
}

.bar-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 4px;
    max-width: 100%;

    &.cpu {
    }

    &.mem {
    }

    &.swap {
    }
}

.bar-inlabel {
    position: absolute;
    left: 6px;
    top: 0;
    z-index: 2;
    font-size: var(--font-size-xs);
    line-height: 18px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}

.bar-right {
    position: absolute;
    right: 6px;
    top: 0;
    line-height: 18px;
    font-size: var(--font-size-xs);
    z-index: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
</style>
