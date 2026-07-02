"use client";

import { useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import Icon from "@/components/Icon";
import type { MenuItem } from "@/components/DefaultMenuItems";
import type { TransferItem, TransferStatus } from "@/stores/downloadStore";
import { countdownText } from "@/utils";
import { CustomMenusEventKey } from "@/utils/constant";
import { removeLocalIfAny } from "@/utils/localFsUtils";
import { formatAdaptiveBytes, formatSpeedBps } from "@/utils/project";
import { showToast } from "@/utils/ui";
import "./index.scss";

export type SftpTransferItemProps = {
    item: TransferItem;
    level?: number;
};

function statusText(status: TransferStatus): string {
    if (status === "running") return "进行中";
    if (status === "queued") return "排队";
    if (status === "paused") return "已暂停";
    if (status === "cancelled") return "已取消";
    if (status === "success") return "完成";
    return "失败";
}

export default function SftpTransferItem({ item, level = 0 }: SftpTransferItemProps) {
    const [open, setOpen] = useState(true);
    const [renderChildren, setRenderChildren] = useState(true);
    const [childrenClosing, setChildrenClosing] = useState(false);
    const canPause = item.status === "running" || item.status === "queued";
    const canResume = item.status === "paused";
    const canCancel = ["running", "queued", "paused", "error"].includes(item.status);
    const canRetry = item.status === "error";
    const percent = ((item.loaded / (item.total || 1)) * 100).toFixed(2);

    async function handleOpenFile() {
        if (!item.localPath || item.isDir) return;
        try {
            await openPath(item.localPath);
        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : "打开文件失败", "error");
        }
    }

    async function handleRevealInDir() {
        if (!item.localPath) return;
        try {
            await revealItemInDir(item.localPath);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "打开所在位置失败", "error");
        }
    }

    function openContextMenu(event: React.MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        const menus: MenuItem[] = [
            { label: "打开", disabled: item.isDir, handler: () => void handleOpenFile() },
            { label: "打开所在位置", handler: () => void handleRevealInDir() },
            "---",
            {
                label: "取消并删除本地",
                handler: () => {
                    void item.cancel();
                    void removeLocalIfAny(item.localPath);
                },
            },
        ];
        document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: event.nativeEvent } }));
    }

    function toggleChildren(event: React.MouseEvent) {
        event.stopPropagation();
        if (open) {
            setOpen(false);
            setChildrenClosing(true);
            return;
        }
        setRenderChildren(true);
        setChildrenClosing(false);
        // 先把子节点挂载到关闭态，下一帧再打开，复刻 Vue Transition 的 enter 过渡。
        window.requestAnimationFrame(() => setOpen(true));
    }

    function handleChildrenTransitionEnd(event: React.TransitionEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget || !childrenClosing) return;
        setRenderChildren(false);
        setChildrenClosing(false);
    }

    if (item.status === "cancelled") return null;

    return (
        <div style={{ marginLeft: `${level * 24}px` }} className="SftpTransferItem transfer-item" onContextMenu={openContextMenu}>
            <div className="title-line">
                <div className={`line1 ${item.isDir ? "is-dir" : "is-file"}`}>
                    <div className="flex items-center gap-2">
                        {item.isDir ? <Icon icon={open ? "mdi:chevron-down" : "mdi:chevron-right"} className="group-ic" onClick={toggleChildren} /> : null}
                        <Icon icon={item.kind === "download" ? "mdi:download" : "mdi:upload"} className="group-ic" />
                        <span className="item-name truncate">{item.name}</span>
                    </div>
                    <div className="item-actions" onClick={(event) => event.stopPropagation()}>
                        {canPause ? (
                            <button type="button" className={`tx-btn${item.loadingFlag === "stop" ? " tx-btn--inline-loading" : ""}`} disabled={item.loadingFlag !== "none"} onClick={() => void item.stop()}>
                                {item.loadingFlag === "stop" ? <Icon icon="mdi:loading" className="tx-btn-load-ic" /> : null}
                                暂停
                            </button>
                        ) : null}
                        {canResume ? (
                            <button type="button" className="tx-btn" disabled={item.loadingFlag !== "none"} onClick={() => void item.resume()}>
                                继续
                            </button>
                        ) : null}
                        {canCancel ? (
                            <button type="button" className="tx-btn tx-btn--danger" disabled={item.loadingFlag !== "none"} onClick={() => void item.cancel()}>
                                取消
                            </button>
                        ) : null}
                        {canRetry ? (
                            <button type="button" className="tx-btn tx-btn--accent" onClick={() => void item.retry()}>
                                重试
                            </button>
                        ) : null}
                    </div>
                </div>
                <div className="line2 progress">
                    <div className="download-track">
                        <div key={item.loaded} className="download-bar" style={{ width: `${percent}%` }} />
                    </div>
                    <p className="bfb">{percent}%</p>
                    <span className="item-name size-name">{item.isDir ? `${item.loaded}/${item.total}` : `${formatAdaptiveBytes(item.loaded)}/${formatAdaptiveBytes(item.total ?? 0)}`}</span>
                    <div className="bps">{item.status === "running" ? formatSpeedBps(item.speedBps) : "0B/s"}</div>
                    <div className="remaining-time">{countdownText(item.remainingTime ?? 0)}</div>
                    <span className={`item-state ${item.status}`}>
                        {item.error} {statusText(item.status)}
                    </span>
                </div>
            </div>
            {renderChildren ? (
                <div className={`children ${open ? "children--open" : "children--closed"}`} onTransitionEnd={handleChildrenTransitionEnd}>
                    {item.children?.map((child) => (
                        <SftpTransferItem key={child.id} item={child} level={level + 1} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
