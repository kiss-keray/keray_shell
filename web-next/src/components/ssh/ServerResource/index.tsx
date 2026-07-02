"use client";

import { useChannelInstancesStore, isChannelInstance } from "@/stores/channelInstances";
import { useServerOverviewStore, type OverviewProcessSort } from "@/stores/serverOverview";
import "./index.scss";

export default function ServerResource() {
    const instances = useChannelInstancesStore((state) => state.instances);
    const selectSessionId = useChannelInstancesStore((state) => state.selectSessionId);
    const selectSession = instances.find((item) => item.sessionId === selectSessionId);
    const instance = selectSession && isChannelInstance(selectSession) ? selectSession : null;
    const overview = instance?.overview;
    const processes = overview?.processes ?? [];
    const procSort: OverviewProcessSort = overview?.processSort === "cpu" ? "cpu" : "mem";
    const ifaceOptions = overview?.ifaceOptions.length ? overview.ifaceOptions : overview?.iface ? [overview.iface] : ["—"];
    const chartScaleSource = Math.max(chartYTailMax(overview?.netUpSeries ?? []), chartYTailMax(overview?.netDownSeries ?? []));
    const chartScale = netChartScale(chartScaleSource);
    const chartPlotMax = netTickTop(chartScaleSource / chartScale.divisor) * chartScale.divisor;
    const chartTicks = [chartPlotMax / chartScale.divisor, (chartPlotMax / chartScale.divisor) * (2 / 3), (chartPlotMax / chartScale.divisor) / 3].map((value) => `${fmtNetTick(value)}${chartScale.suffix}`);

    const chartUpPath = buildChartPath(overview?.netUpSeries ?? [], chartPlotMax);
    const chartDownPath = buildChartPath(overview?.netDownSeries ?? [], chartPlotMax);

    function setProcSort(v: OverviewProcessSort) {
        if (instance?.sessionId) void useServerOverviewStore.getState().setOverviewProcessSort(instance.sessionId, v);
    }

    function setIface(v: string) {
        if (instance?.sessionId) void useServerOverviewStore.getState().setOverviewIface(instance.sessionId, v);
    }

    return (
        <div className="ServerResource module resource">
            <div className="proc-toolbar">
                <span className="proc-toolbar-label">进程 TOP5</span>
                <span className="proc-toolbar-hint">点击「内存 / CPU」表头按该项降序</span>
            </div>
            <table className="tbl proc">
                <colgroup>
                    <col className="col-mem" />
                    <col className="col-cpu" />
                    <col className="col-cmd" />
                </colgroup>
                <thead>
                    <tr>
                        <th scope="col" className={`proc-th-sort${procSort === "mem" ? " proc-th-sort--active" : ""}`} aria-sort={procSort === "mem" ? "descending" : "none"}>
                            <button type="button" className="proc-sort-btn" onClick={() => setProcSort("mem")}>
                                <span className="proc-sort-label">内存</span>
                                {procSort === "mem" ? (
                                    <span className="proc-sort-mark" title="当前按内存降序">
                                        ↓
                                    </span>
                                ) : null}
                            </button>
                        </th>
                        <th scope="col" className={`proc-th-sort${procSort === "cpu" ? " proc-th-sort--active" : ""}`} aria-sort={procSort === "cpu" ? "descending" : "none"}>
                            <button type="button" className="proc-sort-btn" onClick={() => setProcSort("cpu")}>
                                <span className="proc-sort-label">CPU</span>
                                {procSort === "cpu" ? (
                                    <span className="proc-sort-mark" title="当前按 CPU 降序">
                                        ↓
                                    </span>
                                ) : null}
                            </button>
                        </th>
                        <th scope="col" className="proc-th-plain">
                            命令
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {processes.map((p, i) => (
                        <tr key={i} className={i % 2 === 1 ? "alt" : ""}>
                            <td>{p.mem}</td>
                            <td>{p.cpu}</td>
                            <td className="cmd">{p.cmd}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="net-toolbar">
                <span className="net-up">↑ {overview?.netUp ?? ""}</span>
                <span className="net-down">↓ {overview?.netDown ?? ""}</span>
                <select value={overview?.iface ?? ""} className="iface-select" onChange={(event) => setIface(event.target.value)}>
                    {ifaceOptions.map((o) => (
                        <option key={o} value={o}>
                            {o}
                        </option>
                    ))}
                </select>
            </div>
            <div className="chart-wrap">
                <div className="chart-y">
                    {chartTicks.map((tick) => (
                        <span key={tick}>{tick}</span>
                    ))}
                </div>
                <svg className="chart" viewBox="0 0 100 40" preserveAspectRatio="none" overflow="hidden">
                    <path className="chart-grid" d="M 0 0 L 100 0 M 0 13.33 L 100 13.33 M 0 26.66 L 100 26.66 M 0 40 L 100 40" />
                    <path className="chart-line chart-line-down" d={chartDownPath} />
                    <path className="chart-line chart-line-up" d={chartUpPath} />
                </svg>
            </div>
            <div className="net-footer">
                <span>{overview?.latency ?? ""}</span>
                <span>本机</span>
            </div>
        </div>
    );
}

const CHART_Y_AXIS_TAIL = 6;
const KiB = 1024;
const MiB = KiB * KiB;

function chartYTailMax(values: number[]): number {
    const n = values.length;
    if (n === 0) return 1;
    const tail = Math.min(n, CHART_Y_AXIS_TAIL);
    const slice = tail >= n ? values : values.slice(-tail);
    return Math.max(1, ...slice);
}

function netChartScale(maxRaw: number) {
    if (maxRaw >= MiB) return { divisor: MiB, suffix: "G" };
    if (maxRaw >= KiB) return { divisor: KiB, suffix: "M" };
    return { divisor: 1, suffix: "K" };
}

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

function buildChartPath(series: number[], chartPlotMax: number) {
    const n = series.length;
    const w = 100;
    const h = 40;
    // 纵轴按最近窗口的 nice tick 归一化，避免历史尖峰长期压扁当前曲线。
    const max = Math.max(chartPlotMax, 1);
    if (n < 2) {
        const y = h - ((series[0] ?? 0) / max) * h;
        return `M 0 ${y} L ${w} ${y}`;
    }
    return series.map((v, i) => `${i === 0 ? "M" : "L"} ${(i / (n - 1)) * w} ${h - (v / max) * h}`).join(" ");
}
