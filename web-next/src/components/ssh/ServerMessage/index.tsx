"use client";

import { useChannelInstancesStore, isChannelInstance } from "@/stores/channelInstances";
import { showToast } from "@/utils/ui";
import "./index.scss";

export default function ServerMessage() {
    const selectSession = useChannelInstancesStore((state) => state.selectSession);
    const instance = selectSession && isChannelInstance(selectSession) ? selectSession : null;
    const overview = instance?.overview;
    const metrics = {
        uptimeDays: overview?.uptimeDays ?? 0,
        load: overview?.load ?? "-",
        cpuPct: overview?.cpuPct ?? 0,
        mem: overview?.mem ?? { used: 0, total: 0, pct: 0 },
        swap: overview?.swap ?? { used: 0, total: 0, pct: 0 },
    };

    const syncLabel = instance?.status === "connected" ? "已连接" : instance?.status === "disconnected" ? "已断开" : "未连接";
    const syncClass = instance?.status === "connected" ? "ok" : instance?.status === "disconnected" ? "bad" : "idle";

    async function copyIp() {
        const ip = instance?.server.ip;
        if (!ip) return;
        try {
            await navigator.clipboard.writeText(ip);
            showToast("复制成功", "success");
        } catch {
            // ignore
        }
    }

    return (
        <div className="ServerMessage module message">
            <div data-tauri-drag-region="" className="row sync">
                <span className="sync-txt">同步状态</span>
                <span className={`sync-dot ${syncClass}`} title={syncLabel} />
            </div>
            <div className="row ip-row">
                <span className="ip-label">IP {instance?.server.ip}</span>
                <button type="button" className="btn-copy" onClick={() => void copyIp()}>
                    复制
                </button>
            </div>
            <div className="banner">系统信息</div>
            <div className="metric-line">运行 {metrics.uptimeDays} 天</div>
            <div className="metric-line">负载 {metrics.load}</div>
            <div className="bar-row">
                <span className="bar-label">CPU</span>
                <div className="bar-track">
                    <div className="bar-fill cpu" style={{ width: `${metrics.cpuPct}%` }} />
                    <span className="bar-inlabel">{metrics.cpuPct}%</span>
                </div>
            </div>
            <div className="bar-row">
                <span className="bar-label">内存</span>
                <div className="bar-track">
                    <div className="bar-fill mem" style={{ width: `${metrics.mem.pct}%` }} />
                    <span className="bar-right">
                        {metrics.mem.used}/{metrics.mem.total}
                    </span>
                </div>
            </div>
            <div className="bar-row">
                <span className="bar-label">交换</span>
                <div className="bar-track">
                    <div className="bar-fill swap" style={{ width: `${metrics.swap.pct}%` }} />
                    <span className="bar-right">
                        {metrics.swap.used}/{metrics.swap.total}
                    </span>
                </div>
            </div>
        </div>
    );
}
