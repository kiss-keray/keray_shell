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
    mem: { used: number; total: number; pct: number };
    swap: { used: number; total: number; pct: number };
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

/**
 * 与远端采集脚本一致的网卡展示顺序：物理网卡（ens/enp/eno/eth 等）优先，虚拟/桥接靠后。
 */
function preferIfaceOrder(names: string[]): string[] {
    const rank = (name: string): [number, string] => {
        const n = name.toLowerCase();
        if (
            n.startsWith("docker") ||
            n.startsWith("br-") ||
            n.startsWith("veth") ||
            n.startsWith("virbr") ||
            n.startsWith("tun") ||
            n.startsWith("tap") ||
            n.startsWith("wg") ||
            n.startsWith("dummy")
        ) {
            return [200, n];
        }
        if (n.startsWith("ens") || n.startsWith("enp") || n.startsWith("eno") || n.startsWith("enx")) {
            return [0, n];
        }
        /** Linux 上常见的 en0 / en1 等数字编号物理网卡 */
        if (/^en\d+$/.test(n)) {
            return [0, n];
        }
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

/**
 * 若远端 JSON 带有 error 字段，写入面板并返回 true（调用方应跳过后续字段解析）。
 * 否则清空面板 error，返回 false。
 */
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

/**
 * CPU 利用率：远端不再阻塞 sleep 做两次采样，而是一次性输出 /proc/stat 的累计 idle / total，
 * 由前端根据上一次采样做差分（与网速差分一致），再用 EMA 平滑展示。
 */
function ingestCpuFromIdleTotal(o: ServerOverviewState, idleRaw: unknown, totalRaw: unknown) {
    const idle = Number(idleRaw);
    const total = Number(totalRaw);
    if (!Number.isFinite(idle) || !Number.isFinite(total) || total <= 0) return;

    if (o._prevCpuIdle !== undefined && o._prevCpuTotal !== undefined) {
        const dIdle = idle - o._prevCpuIdle;
        const dTotal = total - o._prevCpuTotal;
        if (dTotal > 0) {
            let raw = 100 * (1 - dIdle / dTotal);
            if (raw < 0) raw = 0;
            else if (raw > 100) raw = 100;
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
    if (!o.iface || !o.ifaceOptions.includes(o.iface)) {
        o.iface = o.ifaceOptions[0] ?? defaultIface;
    }
    if (o._prevIface !== o.iface) resetNetSampling(o);

    return o.iface;
}

function hasPreviousNetSample(o: ServerOverviewState): o is ServerOverviewState & Required<Pick<ServerOverviewState, "_prevRx" | "_prevTx" | "_prevTs">> {
    return o._prevRx !== undefined && o._prevTx !== undefined && o._prevTs !== undefined;
}

function formatNetSpeedFromKiBps(kibps: number): string {
    return `${formatAdaptiveBytes(kibps * 1024)}/s`;
}

function updateNetRate(o: ServerOverviewState, rx: number, tx: number, now = Date.now()) {
    if (hasPreviousNetSample(o)) {
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

export function getOverview(instance: ChannelInstance): ServerOverviewState | undefined {
    return instance?.overview;
}

export function createOverview(instance: ChannelInstance): ServerOverviewState {
    instance.overview = createDefaultServerOverview();
    return instance.overview;
}

/** 核心轮询失败等场景：直接设置错误文案并结束 loading */
export function setOverviewError(instance: ChannelInstance, msg: string) {
    const o = getOverview(instance);
    if (!o) return;
    o.error = msg;
    o.loading = false;
}

/**
 * 用户在面板中切换网卡：与 ingest 使用同一 iface 字段，
 * 并清空差分与平滑状态，避免混用上一块网卡的采样。
 */
export function setOverviewIface(instance: ChannelInstance, iface: string) {
    const o = getOverview(instance);
    if (!o || !iface) return;
    if (o.ifaceOptions.length > 0 && !o.ifaceOptions.includes(iface)) return;
    if (o.iface === iface) return;
    o.iface = iface;
    resetNetSampling(o, iface);
}

/**
 * 处理「CPU / 内存 / 交换 / 负载 / 运行时间」脚本输出。
 * latencyLabel 非空时写入 latency（仅核心路调用，避免与 1s 网速轮询互相覆盖）。
 */
export function ingestRemoteOverviewCore(instance: ChannelInstance, remote: Record<string, unknown>, latencyLabel: string) {
    const o = getOverview(instance);
    if (!o) return;
    o.loading = false;
    if (applyRemoteOverviewErrorIfAny(o, remote)) return;

    if ("uptime_days" in remote) o.uptimeDays = Number(remote.uptime_days) || 0;
    if ("load" in remote) o.load = String(remote.load ?? "-");
    if ("cpu" in remote && remote.cpu && typeof remote.cpu === "object") {
        const cpu = remote.cpu as { idle?: unknown; total?: unknown };
        ingestCpuFromIdleTotal(o, cpu.idle, cpu.total);
    }
    if ("mem" in remote) {
        const mem = remote.mem as ServerOverviewState["mem"] | undefined;
        if (mem && typeof mem === "object") o.mem = { ...mem };
    }
    if ("swap" in remote) {
        const swap = remote.swap as ServerOverviewState["swap"] | undefined;
        if (swap && typeof swap === "object") o.swap = { ...swap };
    }
    if (latencyLabel !== "") o.latency = latencyLabel;
}

/**
 * 处理网速脚本输出：合并网卡列表、维护选中网卡、按累计 rx/tx 差分计算上下行速率并做 EMA 平滑。
 */
export function ingestRemoteOverviewNet(instance: ChannelInstance, remote: Record<string, unknown>) {
    const o = getOverview(instance);
    if (!o) return;
    o.loading = false;
    if (applyRemoteOverviewErrorIfAny(o, remote)) return;

    const hasNet = "net_by_iface" in remote || "ifaces" in remote || "iface" in remote || "net_rx" in remote || "net_tx" in remote;
    if (!hasNet) return;

    const nb = readNetByIface(remote.net_by_iface);
    /** ifaces 与 net_by_iface 同源，合并可避免某次轮询 ifaces 异常时误判网卡无效并重置用户选择 */
    const iface = syncSelectedIface(o, remote, nb);
    const pr = nb?.[iface] ?? [Number(remote.net_rx) || 0, Number(remote.net_tx) || 0];
    const rx = Number(pr[0]) || 0;
    const tx = Number(pr[1]) || 0;
    updateNetRate(o, rx, tx);
}

/** 处理进程 TOP5 脚本输出，整表替换 */
export function ingestRemoteOverviewProcesses(instance: ChannelInstance, remote: Record<string, unknown>) {
    const o = getOverview(instance);
    if (!o) return;
    o.loading = false;
    if (applyRemoteOverviewErrorIfAny(o, remote)) return;

    const procs = remote.processes as ServerOverviewState["processes"] | undefined;
    if (Array.isArray(procs)) o.processes = procs;
}

/** 处理 df 磁盘列表脚本输出，整表替换 */
export function ingestRemoteOverviewDisks(instance: ChannelInstance, remote: Record<string, unknown>) {
    const o = getOverview(instance);
    if (!o) return;
    o.loading = false;
    if (applyRemoteOverviewErrorIfAny(o, remote)) return;

    const disks = remote.disks as ServerOverviewState["disks"] | undefined;
    if (Array.isArray(disks)) o.disks = disks;
}
