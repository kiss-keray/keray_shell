import { create } from "zustand";
import { formatAdaptiveBytes } from "@/utils/project";

/** 资源面板进程列表排序：按内存或 CPU 占比降序，脚本侧只取 TOP5 */
export type OverviewProcessSort = "mem" | "cpu";

/**
 * 单个 SSH 会话对应的服务器资源概览状态。
 * 由多路轮询（核心指标 / 网速 / 进程 / 磁盘）分别写入不同字段，在 UI 上合并展示。
 */
export interface ServerOverviewState {
    /** 首次拉取完成前为 true，任意一路 ingest 成功后置 false */
    loading: boolean;
    /** 采集失败或远端返回 error 时的提示文案 */
    error: string | null;
    uptimeDays: number;
    load: string;
    cpuPct: number;
    mem: { used: number | string; total: number | string; pct: number };
    swap: { used: number | string; total: number | string; pct: number };
    processes: Array<{ mem: string; cpu: string; cmd: string }>;
    /** 进程表排序方式（默认内存），轮询脚本会读取以决定 ps 排序键 */
    processSort: OverviewProcessSort;
    disks: Array<{ path: string; avail: string; size: string; pct: number; root?: boolean }>;
    /** 当前选中的网卡名，与网速曲线、上下行文案一致 */
    iface: string;
    /** 远端枚举到的网卡列表（经 preferIfaceOrder 排序），供下拉切换 */
    ifaceOptions: string[];
    netUp: string;
    netDown: string;
    /** 最近若干次的「总吞吐」采样（兼容旧逻辑） */
    netSeries: number[];
    /** 最近若干次上传速率采样（KiB/s） */
    netUpSeries: number[];
    /** 最近若干次下载速率采样（KiB/s） */
    netDownSeries: number[];
    /** 最近一次核心脚本往返耗时文案，仅由核心轮询更新 */
    latency: string;
    /** 网速差分：上一采样点的累计 rx/tx 字节与时间戳 */
    _prevRx?: number;
    _prevTx?: number;
    _prevTs?: number;
    /** 上一采样使用的网卡，切换网卡时重置差分状态 */
    _prevIface?: string;
    /** 以下划线前缀字段仅用于展示平滑，不参与业务判断 */
    _cpuPctSmoothReady?: boolean;
    /** 上一次远端 /proc/stat 累计 idle 与 total，用于本地差分计算 cpuPct */
    _prevCpuIdle?: number;
    _prevCpuTotal?: number;
    _netKbpsUpEma?: number;
    _netKbpsDownEma?: number;
    _netChartKEma?: number;
}

const NET_SERIES_POINTS = 12;

function createEmptyNetSeries(): number[] {
    return Array(NET_SERIES_POINTS).fill(0);
}

/** 新建会话挂载资源面板时的 overview 初始值 */
export function createDefaultServerOverview(): ServerOverviewState {
    return {
        loading: true,
        error: null,
        uptimeDays: 0,
        load: "-",
        cpuPct: 0,
        mem: { used: 0, total: 0, pct: 0 },
        swap: { used: 0, total: 0, pct: 0 },
        processes: [],
        processSort: "mem",
        disks: [],
        iface: "",
        ifaceOptions: [],
        netUp: "-",
        netDown: "-",
        netSeries: createEmptyNetSeries(),
        netUpSeries: createEmptyNetSeries(),
        netDownSeries: createEmptyNetSeries(),
        latency: "-",
    };
}

function preferIfaceOrder(names: string[]): string[] {
    const rank = (name: string): [number, string] => {
        const n = name.toLowerCase();
        if (n.startsWith("docker") || n.startsWith("br-") || n.startsWith("veth") || n.startsWith("virbr") || n.startsWith("tun") || n.startsWith("tap") || n.startsWith("wg") || n.startsWith("dummy")) {
            return [200, n];
        }
        if (n.startsWith("ens") || n.startsWith("enp") || n.startsWith("eno") || n.startsWith("enx")) return [0, n];
        /** Linux 上常见的 en0 / en1 等数字编号物理网卡 */
        if (/^en\d+$/.test(n)) return [0, n];
        if (n.startsWith("en")) return [1, n];
        if (n.startsWith("eth")) return [2, n];
        if (n.startsWith("wlan") || n.startsWith("wlp")) return [3, n];
        return [10, n];
    };
    return [...names].sort((a, b) => {
        const [ra, na] = rank(a);
        const [rb, nb] = rank(b);
        if (ra !== rb) return ra - rb;
        return na.localeCompare(nb);
    });
}

function applyRemoteOverviewErrorIfAny(o: ServerOverviewState, remote: Record<string, unknown>): boolean {
    if (remote.error !== undefined && remote.error !== null) {
        o.error = String(remote.error);
        return true;
    }
    o.error = null;
    return false;
}

function resetNetSampling(o: ServerOverviewState, iface = o.iface) {
    o._prevRx = undefined;
    o._prevTx = undefined;
    o._prevTs = undefined;
    o._prevIface = iface;
    o.netSeries = createEmptyNetSeries();
    o.netUpSeries = createEmptyNetSeries();
    o.netDownSeries = createEmptyNetSeries();
    o.netUp = "-";
    o.netDown = "-";
    o._netKbpsUpEma = undefined;
    o._netKbpsDownEma = undefined;
    o._netChartKEma = undefined;
}

function ingestCpuFromIdleTotal(o: ServerOverviewState, idleRaw: unknown, totalRaw: unknown) {
    const idle = Number(idleRaw);
    const total = Number(totalRaw);
    if (!Number.isFinite(idle) || !Number.isFinite(total) || total <= 0) return;
    if (o._prevCpuIdle !== undefined && o._prevCpuTotal !== undefined) {
        const dIdle = idle - o._prevCpuIdle;
        const dTotal = total - o._prevCpuTotal;
        if (dTotal > 0) {
            const raw = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
            if (!o._cpuPctSmoothReady) {
                o.cpuPct = Math.trunc(raw);
                o._cpuPctSmoothReady = true;
            } else {
                o.cpuPct = Math.trunc(0.62 * o.cpuPct + 0.38 * raw);
            }
        }
    }
    o._prevCpuIdle = idle;
    o._prevCpuTotal = total;
}

function readNetByIface(value: unknown): Record<string, number[]> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, number[]>;
}

function normalizeIfaceOptions(remote: Record<string, unknown>, netByIface?: Record<string, number[]>): string[] {
    const fromIfaces = Array.isArray(remote.ifaces) ? remote.ifaces.map((x) => String(x)) : [];
    const fromNetByIface = netByIface ? Object.keys(netByIface) : [];
    return preferIfaceOrder([...new Set([...fromIfaces, ...fromNetByIface])]);
}

function syncSelectedIface(o: ServerOverviewState, remote: Record<string, unknown>, netByIface?: Record<string, number[]>): string {
    const options = normalizeIfaceOptions(remote, netByIface);
    const defaultIface = String(remote.iface ?? "");
    o.ifaceOptions = options.length > 0 ? options : defaultIface ? [defaultIface] : [];
    if (!o.iface || !o.ifaceOptions.includes(o.iface)) o.iface = o.ifaceOptions[0] ?? defaultIface;
    if (o._prevIface !== o.iface) resetNetSampling(o);
    return o.iface;
}

function formatNetSpeedFromKiBps(kibps: number): string {
    return `${formatAdaptiveBytes(kibps * 1024)}/s`;
}

function updateNetRate(o: ServerOverviewState, rx: number, tx: number, now = Date.now()) {
    if (o._prevRx !== undefined && o._prevTx !== undefined && o._prevTs !== undefined) {
        const dtRaw = (now - o._prevTs) / 1000;
        /** 轮询约 1s，但 RTT 波动会让 dt 忽大忽小；夹紧后速率更稳 */
        const dt = Math.min(4, Math.max(0.35, dtRaw));
        if (dtRaw > 0.05) {
            const dRx = Math.max(0, rx - o._prevRx);
            const dTx = Math.max(0, tx - o._prevTx);
            const upKbps = dTx / dt / 1024;
            const downKbps = dRx / dt / 1024;
            o._netKbpsUpEma = o._netKbpsUpEma === undefined ? upKbps : 0.55 * o._netKbpsUpEma + 0.45 * upKbps;
            o._netKbpsDownEma = o._netKbpsDownEma === undefined ? downKbps : 0.55 * o._netKbpsDownEma + 0.45 * downKbps;
            o.netUp = formatNetSpeedFromKiBps(o._netKbpsUpEma);
            o.netDown = formatNetSpeedFromKiBps(o._netKbpsDownEma);
            o.netUpSeries = [...o.netUpSeries.slice(-(NET_SERIES_POINTS - 1)), Math.max(0, Math.round(o._netKbpsUpEma))];
            o.netDownSeries = [...o.netDownSeries.slice(-(NET_SERIES_POINTS - 1)), Math.max(0, Math.round(o._netKbpsDownEma))];
            const chartK = (dRx + dTx) / dt / 1024;
            o._netChartKEma = o._netChartKEma === undefined ? chartK : 0.52 * o._netChartKEma + 0.48 * chartK;
            o.netSeries = [...o.netSeries.slice(-(NET_SERIES_POINTS - 1)), Math.max(0, Math.round(o._netChartKEma))];
        }
    }
    o._prevRx = rx;
    o._prevTx = tx;
    o._prevTs = now;
}

type ServerOverviewStore = {
    setOverviewError: (sid: string, msg: string) => void;
    setOverviewIface: (sid: string, iface: string) => void;
    setOverviewProcessSort: (sid: string, sort: OverviewProcessSort) => void;
    ingestRemoteOverviewCore: (sid: string, remote: Record<string, unknown>, latencyLabel: string) => void;
    ingestRemoteOverviewNet: (sid: string, remote: Record<string, unknown>) => void;
    ingestRemoteOverviewProcesses: (sid: string, remote: Record<string, unknown>) => void;
    ingestRemoteOverviewDisks: (sid: string, remote: Record<string, unknown>) => void;
};

async function getOverview(sid: string): Promise<ServerOverviewState | undefined> {
    const { useChannelInstancesStore, isChannelInstance } = await import("@/stores/channelInstances");
    const inst = useChannelInstancesStore.getState().instances.find((i) => i.sessionId === sid);
    return inst && isChannelInstance(inst) ? inst.overview : undefined;
}

async function touchInstances() {
    const { notifyChannelInstancesChanged } = await import("@/stores/channelInstances");
    notifyChannelInstancesChanged();
}

export const useServerOverviewStore = create<ServerOverviewStore>(() => ({
    async setOverviewError(sid, msg) {
        const o = await getOverview(sid);
        if (!o) return;
        o.error = msg;
        o.loading = false;
        await touchInstances();
    },
    async setOverviewIface(sid, iface) {
        const o = await getOverview(sid);
        if (!o || !iface) return;
        if (o.ifaceOptions.length > 0 && !o.ifaceOptions.includes(iface)) return;
        if (o.iface === iface) return;
        o.iface = iface;
        resetNetSampling(o, iface);
        await touchInstances();
    },
    async setOverviewProcessSort(sid, sort) {
        const o = await getOverview(sid);
        if (!o) return;
        const nextSort = sort === "cpu" ? "cpu" : "mem";
        if (o.processSort === nextSort) return;
        o.processSort = nextSort;
        // 进程排序会影响下一轮远端 ps 命令，同时这里立即刷新表头状态。
        await touchInstances();
    },
    async ingestRemoteOverviewCore(sid, remote, latencyLabel) {
        const o = await getOverview(sid);
        if (!o) return;
        o.loading = false;
        if (!applyRemoteOverviewErrorIfAny(o, remote)) {
            if ("uptime_days" in remote) o.uptimeDays = Number(remote.uptime_days) || 0;
            if ("load" in remote) o.load = String(remote.load ?? "-");
            if ("cpu" in remote && remote.cpu && typeof remote.cpu === "object") {
                const cpu = remote.cpu as { idle?: unknown; total?: unknown };
                ingestCpuFromIdleTotal(o, cpu.idle, cpu.total);
            }
            if ("mem" in remote && remote.mem && typeof remote.mem === "object") o.mem = { ...(remote.mem as ServerOverviewState["mem"]) };
            if ("swap" in remote && remote.swap && typeof remote.swap === "object") o.swap = { ...(remote.swap as ServerOverviewState["swap"]) };
            if (latencyLabel !== "") o.latency = latencyLabel;
        }
        await touchInstances();
    },
    async ingestRemoteOverviewNet(sid, remote) {
        const o = await getOverview(sid);
        if (!o) return;
        o.loading = false;
        if (!applyRemoteOverviewErrorIfAny(o, remote)) {
            const hasNet = "net_by_iface" in remote || "ifaces" in remote || "iface" in remote || "net_rx" in remote || "net_tx" in remote;
            if (hasNet) {
                const nb = readNetByIface(remote.net_by_iface);
                /** ifaces 与 net_by_iface 同源，合并可避免某次轮询 ifaces 异常时误判网卡无效并重置用户选择 */
                const iface = syncSelectedIface(o, remote, nb);
                const pr = nb?.[iface] ?? [Number(remote.net_rx) || 0, Number(remote.net_tx) || 0];
                updateNetRate(o, Number(pr[0]) || 0, Number(pr[1]) || 0);
            }
        }
        await touchInstances();
    },
    async ingestRemoteOverviewProcesses(sid, remote) {
        const o = await getOverview(sid);
        if (!o) return;
        o.loading = false;
        if (!applyRemoteOverviewErrorIfAny(o, remote) && Array.isArray(remote.processes)) o.processes = remote.processes as ServerOverviewState["processes"];
        await touchInstances();
    },
    async ingestRemoteOverviewDisks(sid, remote) {
        const o = await getOverview(sid);
        if (!o) return;
        o.loading = false;
        if (!applyRemoteOverviewErrorIfAny(o, remote) && Array.isArray(remote.disks)) o.disks = remote.disks as ServerOverviewState["disks"];
        await touchInstances();
    },
}));
