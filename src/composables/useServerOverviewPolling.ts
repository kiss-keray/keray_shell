import { onUnmounted, watch } from "vue";
import { formatAdaptiveBytes, invoke } from "@/utils/project";
import { useChannelInstancesStore } from "@/stores/channelInstances";
import type { ChannelInstance } from "@/stores/channelInstances";
import { useServerOverviewStore } from "@/stores/serverOverview";
import type { ServerOverviewState } from "@/stores/serverOverview";

/** 核心指标（CPU/内存/网速）轮询间隔（毫秒） */
const FAST_INTERVAL_MS = 1000;
/** 进程列表与磁盘列表轮询间隔（毫秒），降低远端 ps/df 频率 */
const SLOW_INTERVAL_MS = 10000;

type OverviewPollKind = "fast" | "proc" | "disk";
type ActiveOverviewInstance = { id: string; inst: ChannelInstance & { overview: ServerOverviewState } };

/**
 * POSIX sh 中单引号包裹的字面量；若字符串含 `'` 则拆成 `'\''` 拼接。
 * 用于把用户偏好网卡名安全嵌入远端脚本。
 */
function shSingleQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 「核心 + 网速」合并采集：单 awk 读 /proc 与 /proc/net/dev，只输出制表符分隔的原始行，
 * 由前端 `parseFastOverviewText` 解析并计算占用百分比、GiB 等与 store 一致的结构。
 *
 * 行格式：
 * 1: uptime_sec, load1, load2, load3
 * 2: mem_total_kb, mem_avail_kb, swap_total_kb, swap_free_kb
 * 3: cpu_idle, cpu_total（累计 jiffies，与 store 差分算 CPU%）
 * 4: 选中的网卡名（按 IFACE_PREF 或首张非 lo）
 * 5: 网卡行数 N
 * 6..5+N: iface, rx_bytes, tx_bytes
 */
const FAST_AWK_SOURCE = String.raw`BEGIN {
  pref = ENVIRON["IFACE_PREF"]

  mt = 0; ma = 0; st = 0; sf = 0
  while ((getline line < "/proc/meminfo") > 0) {
    n = split(line, f, /[[:space:]]+/)
    if      (f[1] == "MemTotal:")     mt = f[2] + 0
    else if (f[1] == "MemAvailable:") ma = f[2] + 0
    else if (f[1] == "SwapTotal:")    st = f[2] + 0
    else if (f[1] == "SwapFree:")     sf = f[2] + 0
  }
  close("/proc/meminfo")

  l1 = "0"; l2 = "0"; l3 = "0"
  if ((getline line < "/proc/loadavg") > 0) {
    split(line, f, /[[:space:]]+/)
    l1 = f[1]; l2 = f[2]; l3 = f[3]
  }
  close("/proc/loadavg")

  up = 0
  if ((getline line < "/proc/uptime") > 0) {
    split(line, f, /[[:space:]]+/)
    up = f[1] + 0
  }
  close("/proc/uptime")

  cpu_idle = 0; cpu_total = 0
  while ((getline line < "/proc/stat") > 0) {
    if (substr(line, 1, 4) == "cpu ") {
      n = split(line, f, /[[:space:]]+/)
      cpu_idle = f[5] + f[6]
      for (i = 2; i <= n; i++) cpu_total += f[i] + 0
      break
    }
  }
  close("/proc/stat")

  ncnt = 0; nfn = 0; chosen = ""
  while ((getline line < "/proc/net/dev") > 0) {
    nfn++
    if (nfn <= 2) continue
    sub(/^[[:space:]]+/, "", line)
    p = index(line, ":")
    if (p == 0) continue
    name = substr(line, 1, p - 1)
    rest = substr(line, p + 1)
    nf = split(rest, f, /[[:space:]]+/)
    base = (f[1] == "" ? 1 : 0)
    rx = f[base + 1] + 0
    tx = f[base + 9] + 0
    if (name == "lo") continue
    ncnt++
    nics[ncnt] = name; rxs[ncnt] = rx; txs[ncnt] = tx
    if (pref != "" && name == pref) chosen = name
  }
  close("/proc/net/dev")

  if (chosen == "" && ncnt > 0) chosen = nics[1]
  if (chosen == "") chosen = "eth0"

  print up "\t" l1 "\t" l2 "\t" l3
  print mt "\t" ma "\t" st "\t" sf
  print cpu_idle "\t" cpu_total
  print chosen
  print ncnt
  for (i = 1; i <= ncnt; i++) print nics[i] "\t" rxs[i] "\t" txs[i]
}`;

function composeFastOverviewShellScript(preferredIface: string): string {
    const pref = preferredIface.trim();
    return `set -u
exec 2>/dev/null
IFACE_PREF=${shSingleQuote(pref)}
export IFACE_PREF
awk '${FAST_AWK_SOURCE}'
`;
}

/**
 * 进程 TOP5：远端 procps `ps` 按列排序后只取 5 行（无表头）。
 * 若只 `ps … | head 500` 再在前端排序，默认 PID 序会截断高 PID 的高内存进程，与 top 不一致。
 */
function composeProcessesOverviewShellScript(sort: "mem" | "cpu"): string {
    const sortSpec = sort === "cpu" ? "-%cpu" : "-rss";
    return `set -u
exec 2>/dev/null
ps --no-headers -eo rss,pcpu,args --sort=${sortSpec} 2>/dev/null | head -n 5
`;
}

/** df 每行：filesystem、size_kb、used_kb、avail_kb、挂载点（可含空格）；百分比与 human 由前端计算 */
const DISK_AWK_SOURCE = String.raw`NR == 1 { next }
{
  fs = $1; size = $2 + 0; used = $3 + 0; avail = $4 + 0
  mnt = $6
  for (i = 7; i <= NF; i++) mnt = mnt " " $i
  if (fs == "tmpfs" || fs == "devtmpfs" || mnt == "") next
  gsub(/\t/, " ", mnt)
  print fs "\t" size "\t" used "\t" avail "\t" mnt
}`;

function composeDisksOverviewShellScript(): string {
    return `set -u
exec 2>/dev/null
df -P -k 2>/dev/null | awk '${DISK_AWK_SOURCE}'
`;
}

function diskLabelFromKb(kb: number): string {
    if (!Number.isFinite(kb) || kb < 0) return formatAdaptiveBytes(0);
    return formatAdaptiveBytes(kb * 1024);
}

function parseFastOverviewText(raw: string): { core: Record<string, unknown>; net: Record<string, unknown> } {
    const lines = raw
        .split(/\n/)
        .map((l) => l.replace(/\r$/, ""))
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0);
    if (lines.length < 5) throw new Error("核心采集行数不足");

    const row0 = lines[0].split("\t");
    const uptimeSec = Number(row0[0]);
    const load = row0.slice(1, 4).join(" ").trim() || "-";

    const row1 = lines[1].split("\t");
    const mt = Number(row1[0]);
    const ma = Number(row1[1]);
    const st = Number(row1[2]);
    const sf = Number(row1[3]);

    const row2 = lines[2].split("\t");
    const cpuIdle = Number(row2[0]);
    const cpuTotal = Number(row2[1]);

    const chosenIface = lines[3].trim() || "eth0";
    const ncnt = Math.max(0, Math.floor(Number(lines[4])));
    if (lines.length < 5 + ncnt) throw new Error("网卡行数与声明不一致");

    const safeMt = Number.isFinite(mt) && mt > 0 ? mt : 0;
    const mu = Math.max(0, safeMt > 0 ? safeMt - (Number.isFinite(ma) ? ma : 0) : 0);
    const su = Math.max(0, (Number.isFinite(st) ? st : 0) - (Number.isFinite(sf) ? sf : 0));
    const memPct = safeMt > 0 ? Math.trunc((100 * mu) / safeMt) : 0;
    const swapTotal = Number.isFinite(st) ? st : 0;
    const swapPct = swapTotal > 0 ? Math.trunc((100 * su) / swapTotal) : 0;

    const core: Record<string, unknown> = {
        uptime_days: Math.trunc((Number.isFinite(uptimeSec) ? uptimeSec : 0) / 86400),
        load,
        cpu: { idle: cpuIdle, total: cpuTotal },
        mem: {
            used: diskLabelFromKb(mu),
            total: diskLabelFromKb(safeMt),
            pct: memPct,
        },
        swap: {
            used: diskLabelFromKb(su),
            total: diskLabelFromKb(swapTotal),
            pct: swapPct,
        },
    };

    const net_by_iface: Record<string, [number, number]> = {};
    const ifaces: string[] = [];
    for (let i = 5; i < 5 + ncnt; i++) {
        const cols = lines[i].split("\t");
        const name = cols[0]?.trim() ?? "";
        const rx = Number(cols[1]);
        const tx = Number(cols[2]);
        if (!name) continue;
        ifaces.push(name);
        net_by_iface[name] = [Number.isFinite(rx) ? rx : 0, Number.isFinite(tx) ? tx : 0];
    }

    const pr = net_by_iface[chosenIface] ?? [0, 0];
    const net: Record<string, unknown> = {
        iface: chosenIface,
        ifaces,
        net_rx: pr[0],
        net_tx: pr[1],
        net_by_iface,
    };

    return { core, net };
}

function parseProcessesText(raw: string, sort: "mem" | "cpu"): Record<string, unknown> {
    const rows: { rssKb: number; cpu: number; cmd: string }[] = [];
    for (const line of raw.split(/\n/)) {
        const trimmed = line.replace(/\r$/, "").trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^([\d.]+)\s+([\d.]+)\s+(.*)$/);
        if (!m) continue;
        const rssKb = Number(m[1]);
        const cpu = parseFloat(m[2]);
        const cmd = m[3].trim();
        if (!Number.isFinite(rssKb) || rssKb < 0 || !Number.isFinite(cpu)) continue;
        rows.push({ rssKb, cpu, cmd });
    }
    const key = sort === "cpu" ? "cpu" : "rssKb";
    rows.sort((a, b) => b[key] - a[key]);
    const top = rows.slice(0, 5);
    const processes = top.map((r) => ({
        mem: diskLabelFromKb(r.rssKb),
        cpu: `${r.cpu.toFixed(1)}%`,
        cmd: r.cmd,
    }));
    return { processes };
}

function parseDiskOverviewText(raw: string): Record<string, unknown> {
    const disks: Array<{ path: string; avail: string; size: string; pct: number; root?: boolean }> = [];
    for (const line of raw.split(/\n/)) {
        const trimmed = line.replace(/\r$/, "").trimEnd();
        if (!trimmed) continue;
        const tab1 = trimmed.indexOf("\t");
        if (tab1 < 0) continue;
        const tab2 = trimmed.indexOf("\t", tab1 + 1);
        const tab3 = trimmed.indexOf("\t", tab2 + 1);
        const tab4 = trimmed.indexOf("\t", tab3 + 1);
        if (tab2 < 0 || tab3 < 0 || tab4 < 0) continue;
        const fs = trimmed.slice(0, tab1);
        const sizeKb = Number(trimmed.slice(tab1 + 1, tab2));
        const usedKb = Number(trimmed.slice(tab2 + 1, tab3));
        const availKb = Number(trimmed.slice(tab3 + 1, tab4));
        const mnt = trimmed.slice(tab4 + 1).trim();
        if (fs === "tmpfs" || fs === "devtmpfs" || !mnt) continue;
        if (!Number.isFinite(sizeKb) || sizeKb <= 0) continue;
        const pct = (availKb / sizeKb) * 100;
        disks.push({
            path: mnt,
            avail: diskLabelFromKb(Number.isFinite(availKb) ? availKb : 0),
            size: diskLabelFromKb(sizeKb),
            pct,
            root: mnt === "/",
        });
    }
    return { disks };
}

/** 将 UTF-8 字符串转为 base64，供远端解码执行 */
function utf8ToBase64(s: string): string {
    return btoa(unescape(encodeURIComponent(s)));
}

/**
 * 脚本经 base64 封装后由远端 `base64 -d | sh` 执行，避免复杂引号嵌套导致注入或截断。
 */
function buildRemoteInvocation(script: string): string {
    const b64 = utf8ToBase64(script);
    return `printf '%s' '${b64}' | (base64 -d 2>/dev/null || base64 -D 2>/dev/null) | sh`;
}

/* -------------------------------------------------------------------------- */
/* 远端命令缓存：避免每秒重复字符串拼接 + base64 编码                          */
/* -------------------------------------------------------------------------- */

const fastCmdCache = new Map<string, string>();
function getFastRemoteCmd(preferredIface: string): string {
    const key = preferredIface.trim();
    let cached = fastCmdCache.get(key);
    if (cached) return cached;
    cached = buildRemoteInvocation(composeFastOverviewShellScript(key));
    fastCmdCache.set(key, cached);
    return cached;
}

const procCmdCache = new Map<"mem" | "cpu", string>();
function getProcRemoteCmd(sort: "mem" | "cpu"): string {
    let cached = procCmdCache.get(sort);
    if (cached) return cached;
    cached = buildRemoteInvocation(composeProcessesOverviewShellScript(sort));
    procCmdCache.set(sort, cached);
    return cached;
}

let diskCmdCache: string | undefined;
function getDiskRemoteCmd(): string {
    if (diskCmdCache) return diskCmdCache;
    diskCmdCache = buildRemoteInvocation(composeDisksOverviewShellScript());
    return diskCmdCache;
}

/**
 * 在「当前选中的 SSH 会话」上轮询远端 Linux 资源，并写入 Pinia 中对应 ChannelInstance.overview。
 *
 * - 快速轮询（1s）：远端 awk 只输出制表符分隔的原始指标；前端解析并算内存/Swap 占用率、GiB 等后 ingest core/net。
 * - 慢速轮询（10s）：进程为远端 `ps --sort` 后的 TOP5（rss KB + pcpu）；磁盘为 `df` 的 TSV；内存 human 与磁盘百分比在前端处理。
 *
 * 使用序号（seq*）丢弃过期异步结果，避免切换会话后旧请求覆盖新会话数据。
 */
export function useServerOverviewPolling() {
    const store = useServerOverviewStore();
    const instancesStore = useChannelInstancesStore();
    let timerFast: ReturnType<typeof setInterval> | undefined;
    let timerProc: ReturnType<typeof setInterval> | undefined;
    let timerDisk: ReturnType<typeof setInterval> | undefined;
    /** 各路轮询独立序号，仅当回包时仍与当前序号相等且会话仍选中时才 ingest */
    const pollSeq: Record<OverviewPollKind, number> = {
        fast: 0,
        proc: 0,
        disk: 0,
    };

    function clearTimers() {
        clearInterval(timerFast);
        clearInterval(timerProc);
        clearInterval(timerDisk);
    }

    function getActiveOverviewInstance(): ActiveOverviewInstance | undefined {
        const id = instancesStore.selectSessionId;
        const inst = instancesStore.instances.find((i) => i.sessionId === id) as ChannelInstance | undefined;
        if (!inst?.overview || inst.status !== "connected") return undefined;
        return { id, inst: inst as ActiveOverviewInstance["inst"] };
    }

    function isCurrentPoll(kind: OverviewPollKind, seq: number, id: string): boolean {
        return seq === pollSeq[kind] && instancesStore.selectSessionId === id;
    }

    async function runOverviewPoll(kind: OverviewPollKind, id: string, inst: ChannelInstance, label: string, remoteCmd: string, onRaw: (raw: string) => void, onError?: () => void) {
        const seq = ++pollSeq[kind];
        let raw = "";
        try {
            raw = await execRemote(inst.server.id, remoteCmd);
            if (!isCurrentPoll(kind, seq, id)) return;
            onRaw(raw.trim());
        } catch (e) {
            if (!isCurrentPoll(kind, seq, id)) return;
            console.warn(`[overview] ${label} 采集失败`, e, "原始输出:", raw);
            onError?.();
        }
    }

    /** 核心 + 网速合并：1 次 RTT 拿到两块数据，并附带 RTT 文案给面板 latency */
    async function pollFast(id: string, inst: ChannelInstance) {
        const t0 = Date.now();
        const cmd = getFastRemoteCmd(inst.overview?.iface ?? "");
        await runOverviewPoll(
            "fast",
            id,
            inst,
            "核心+网速",
            cmd,
            (raw) => {
                const latency = `${Date.now() - t0} ms`;
                try {
                    const { core, net } = parseFastOverviewText(raw);
                    store.ingestRemoteOverviewCore(id, core, latency);
                    store.ingestRemoteOverviewNet(id, net);
                } catch (e) {
                    console.warn("[overview] 核心+网速解析失败", e, raw);
                    store.setOverviewError(id, "采集失败（需已连接 SSH，远端为 Linux 且可用 sh/awk）");
                }
            },
            () => store.setOverviewError(id, "采集失败（需已连接 SSH，远端为 Linux 且可用 sh/awk）"),
        );
    }

    /** 进程 TOP5：远端已按当前维度排序截断；前端再做内存 human 与展示序稳定化 */
    async function pollProc(id: string, inst: ChannelInstance, procSort: "mem" | "cpu") {
        await runOverviewPoll("proc", id, inst, "进程", getProcRemoteCmd(procSort), (raw) => {
            try {
                store.ingestRemoteOverviewProcesses(id, parseProcessesText(raw, procSort));
            } catch (e) {
                console.warn("[overview] 进程解析失败", e, raw);
            }
        });
    }

    /** 磁盘列表：远端 TSV，human 与 Use% 在前端计算 */
    async function pollDisk(id: string, inst: ChannelInstance) {
        await runOverviewPoll("disk", id, inst, "磁盘", getDiskRemoteCmd(), (raw) => {
            try {
                store.ingestRemoteOverviewDisks(id, parseDiskOverviewText(raw));
            } catch (e) {
                console.warn("[overview] 磁盘解析失败", e, raw);
            }
        });
    }

    /**
     * 根据当前选中会话启动/重置定时器：仅当已连接且存在 overview 时生效。
     * 立即执行三轮各一次，再按 FAST/SLOW 间隔重复。
     */
    function arm() {
        clearTimers();
        const active = getActiveOverviewInstance();
        if (!active) return;
        const { id, inst } = active;
        const procSort = inst.overview.processSort === "cpu" ? "cpu" : "mem";
        void pollFast(id, inst);
        void pollProc(id, inst, procSort);
        void pollDisk(id, inst);
        timerFast = setInterval(() => {
            const current = getActiveOverviewInstance();
            if (!current) return;
            void pollFast(current.id, current.inst);
        }, FAST_INTERVAL_MS);
        timerProc = setInterval(() => {
            const current = getActiveOverviewInstance();
            if (!current) return;
            const sort = current.inst.overview.processSort === "cpu" ? "cpu" : "mem";
            void pollProc(current.id, current.inst, sort);
        }, SLOW_INTERVAL_MS);
        timerDisk = setInterval(() => {
            const current = getActiveOverviewInstance();
            if (!current) return;
            void pollDisk(current.id, current.inst);
        }, SLOW_INTERVAL_MS);
    }

    watch(
        () => {
            const id = instancesStore.selectSessionId;
            const inst = instancesStore.instances.find((i) => i.sessionId === id) as ChannelInstance | undefined;
            return { id, status: inst?.status ?? 0 };
        },
        (cur, prev) => {
            void prev;
            arm();
        },
        { immediate: true },
    );

    /** 切换「按内存 / 按 CPU」：两套远端排序不同，立即再采一轮进程列表 */
    watch(
        () => {
            const id = instancesStore.selectSessionId;
            const inst = instancesStore.instances.find((i) => i.sessionId === id) as ChannelInstance | undefined;
            return {
                id,
                sort: inst?.overview?.processSort === "cpu" ? ("cpu" as const) : ("mem" as const),
            };
        },
        (cur, prev) => {
            if (!cur.id || cur.sort === prev?.sort) return;
            if (instancesStore.selectSessionId !== cur.id) return;
            const inst = instancesStore.instances.find((i) => i.sessionId === cur.id) as ChannelInstance | undefined;
            if (!inst?.overview || inst.status !== "connected") return;
            void pollProc(cur.id, inst, cur.sort);
        },
    );

    onUnmounted(() => {
        clearTimers();
    });
}
