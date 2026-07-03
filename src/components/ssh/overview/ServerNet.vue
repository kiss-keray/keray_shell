<script setup lang="ts">
const props = defineProps<{
    instance: ChannelInstance;
    onlyMount?: boolean;
}>();

const overview = computed<ServerOverviewState | undefined>(() => props.instance?.overview);

/** 折线图按“本机视角”显示，需与 localNetUp/localNetDown 保持一致。 */
const netUpSeries = computed(() => overview.value?.netUpSeries ?? []);
const netDownSeries = computed(() => overview.value?.netDownSeries ?? []);
/**
 * 仅用最近若干点定纵轴，避免缓冲里左侧仍保留的旧尖峰把后续低流量压扁在底部。
 * 与 serverOverview 中 NET_SERIES_POINTS（12）配套：取尾部约一半窗口。
 */
const CHART_Y_AXIS_TAIL = 6;

function chartYTailMax(values: number[]): number {
    const n = values.length;
    if (n === 0) return 1;
    const tail = Math.min(n, CHART_Y_AXIS_TAIL);
    const slice = tail >= n ? values : values.slice(-tail);
    return Math.max(1, ...slice);
}
/** store 中的 netUp/netDown 是远端网卡 TX/RX；面板按“本机”视角展示上传/下载。 */
const localNetUp = computed(() => overview.value?.netUp ?? "");
const localNetDown = computed(() => overview.value?.netDown ?? "");
const latency = computed(() => overview.value?.latency ?? "");
const ifaceOptions = computed(() => {
    const o = overview.value;
    if (!o) return [];
    if (o.ifaceOptions.length) return o.ifaceOptions;
    return o.iface ? [o.iface] : ["—"];
});

/** 与 store.overview.iface 同步，保证图表/上下行速率与 net_by_iface 一致 */
const ifaceModel = computed({
    get: () => overview.value?.iface ?? "",
    set: (v: string) => {
        if (props.instance) setOverviewIface(props.instance, v);
    },
});

/** 网速序列单位为 KiB/s（与 channelInstances 一致） */
const KiB = 1024;
const MiB = KiB * KiB;

const chartYScaleSource = computed(() => Math.max(chartYTailMax(netUpSeries.value), chartYTailMax(netDownSeries.value)));

const netChartScale = computed(() => {
    const maxRaw = Math.max(chartYScaleSource.value, 1);
    if (maxRaw >= MiB) return { divisor: MiB, suffix: "G" };
    if (maxRaw >= KiB) return { divisor: KiB, suffix: "M" };
    return { divisor: 1, suffix: "K" };
});

/** 与左侧刻度顶对齐的绘图上限（nice number），曲线按此值归一化 */
const chartPlotMax = computed(() => {
    const maxRaw = chartYScaleSource.value;
    const { divisor } = netChartScale.value;
    return netTickTop(maxRaw / divisor) * divisor;
});

function netTickTop(scaledMax: number) {
    const sm = scaledMax <= 0 || !Number.isFinite(scaledMax) ? 1 : scaledMax;
    const x = sm * 1.05;
    const pow = Math.floor(Math.log10(x));
    const base = 10 ** pow;
    const m = x / base;
    const niceM = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    let hi = niceM * base;
    if (hi < sm) hi *= 10;
    return hi;
}

function fmtNetTick(v: number) {
    if (!Number.isFinite(v)) return "0";
    const a = Math.abs(v);
    if (a >= 100) return String(Math.round(v));
    if (a >= 10) return Math.abs(v - Math.round(v)) < 0.06 ? String(Math.round(v)) : v.toFixed(1);
    return Math.abs(v - Math.round(v)) < 0.06 ? String(Math.round(v)) : v.toFixed(2);
}

function buildChartPoints(series: number[]) {
    const s = series;
    const n = s.length;
    const w = 100;
    const h = 40;
    const max = Math.max(chartPlotMax.value, 1);
    if (n < 2) {
        const y = h - ((s[0] ?? 0) / max) * h;
        return [
            { x: 0, y },
            { x: w, y },
        ];
    }
    return s.map((v, i) => {
        const x = (i / (n - 1)) * w;
        const y = h - (v / max) * h;
        return { x, y };
    });
}

function buildChartLinePath(points: Array<{ x: number; y: number }>) {
    if (!points.length) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

const chartUpPath = computed(() => {
    const pts = buildChartPoints(netUpSeries.value);
    return buildChartLinePath(pts);
});

const chartDownPath = computed(() => {
    const pts = buildChartPoints(netDownSeries.value);
    return buildChartLinePath(pts);
});

const chartGridPath = computed(() => {
    return "M 0 0 L 100 0 M 0 13.33 L 100 13.33 M 0 26.66 L 100 26.66 M 0 40 L 100 40";
});

const chartTicks = computed(() => {
    const pm = chartPlotMax.value;
    const { divisor, suffix } = netChartScale.value;
    const hi = pm / divisor;
    const t2 = (hi * 2) / 3;
    const t3 = hi / 3;
    return [hi, t2, t3].map((v) => `${fmtNetTick(v)}${suffix}`);
});
</script>

<template>
    <div class="module resource">
        <div class="net-toolbar">
            <span class="net-up">↑ {{ localNetUp }}</span>
            <span class="net-down">↓ {{ localNetDown }}</span>
            <select v-model="ifaceModel" class="iface-select">
                <option v-for="o in ifaceOptions" :key="o" :value="o">{{ o }}</option>
            </select>
        </div>
        <div class="chart-wrap">
            <div class="chart-y">
                <span v-for="t in chartTicks" :key="t">{{ t }}</span>
            </div>
            <svg class="chart" viewBox="0 0 100 40" preserveAspectRatio="none" overflow="hidden">
                <path class="chart-grid" :d="chartGridPath" />
                <path class="chart-line chart-line-down" :d="chartDownPath" />
                <path class="chart-line chart-line-up" :d="chartUpPath" />
            </svg>
        </div>
        <div class="net-footer">
            <span>{{ latency }}</span>
            <span>本机</span>
        </div>
    </div>
</template>

<style scoped lang="scss">
.resource {
    padding: 10px 12px;
    line-height: 1.35;
    border-radius: 8px;
}

.net-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: nowrap;
}

.net-up {
    font-weight: 600;
    text-wrap: nowrap;
}

.net-down {
    font-weight: 600;
    text-wrap: nowrap;
}

.iface-select {
    margin-left: auto;
    font-size: var(--font-size-xs);
    padding: 4px 8px;
    border-radius: 6px;
    max-width: 130px;
    border: none;
    outline: none;
    cursor: pointer;
}

.chart-wrap {
    display: flex;
    margin-top: 8px;
    gap: 6px;
    height: 72px;
}

.chart-y {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: var(--font-size-2xs);
    text-align: right;
    min-width: 3.2em;
    flex-shrink: 0;
    padding: 2px 0;
}

.chart {
    flex: 1;
    width: 100%;
    height: 100%;
    min-height: 64px;
}

.chart-grid {
    fill: none;
    stroke-width: 0.28;
    opacity: 0.45;
}

.chart-line {
    fill: none;
    stroke-width: 1;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.net-footer {
    display: flex;
    justify-content: space-between;
    font-size: var(--font-size-xs);
    margin-top: 6px;
    padding: 0 2px;
}
</style>
