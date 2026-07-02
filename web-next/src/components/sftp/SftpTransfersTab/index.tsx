"use client";

import type { CSSProperties } from "react";
import Icon from "@/components/Icon";
import { CONCURRENCY_MAX, CONCURRENCY_MIN, useDownloadStore } from "@/stores/downloadStore";
import SftpTransferItem from "@/components/sftp/SftpTransferItem";
import "./index.scss";

export type SftpTransfersTabProps = {
    style?: CSSProperties;
};

export default function SftpTransfersTab({ style }: SftpTransfersTabProps) {
    const concurrency = useDownloadStore((state) => state.concurrency);
    const allLoadingFlag = useDownloadStore((state) => state.allLoadingFlag);
    const canPauseAll = useDownloadStore((state) => state.canPauseAll);
    const canResumeAll = useDownloadStore((state) => state.canResumeAll);
    const canCancelAll = useDownloadStore((state) => state.canCancelAll);
    const totalCount = useDownloadStore((state) => state.totalCount);
    const taskItems = useDownloadStore((state) => state.taskItems);
    const setConcurrency = useDownloadStore((state) => state.setConcurrency);
    const stopAllTasks = useDownloadStore((state) => state.stopAllTasks);
    const startAllTasks = useDownloadStore((state) => state.startAllTasks);
    const cancelAllTasks = useDownloadStore((state) => state.cancelAllTasks);
    const cleanFinishedTasks = useDownloadStore((state) => state.cleanFinishedTasks);

    return (
        <div className="SftpTransfersTab transfers-panel flex grow min-h-[120px] flex-col" style={style}>
            <div className="transfers-head flex shrink-0 items-center gap-3 px-3 pt-2 pb-2 text-xs">
                <span className="shrink-0">传输记录（上传/下载）</span>
                <div className="concurrency flex items-center gap-2 shrink-0">
                    <span className="concurrency-label">并行</span>
                    <input
                        value={concurrency}
                        type="range"
                        className="concurrency-slider"
                        min={CONCURRENCY_MIN}
                        max={CONCURRENCY_MAX}
                        step="1"
                        title={`并行 ${concurrency}`}
                        onChange={(event) => setConcurrency(Number(event.target.value))}
                    />
                    <span className="tabular-nums w-5 text-right">{concurrency}</span>
                </div>
                <div className="bulk-actions flex flex-wrap items-center gap-1 shrink-0">
                    <button type="button" className={`tx-btn${allLoadingFlag === "stop" ? " tx-btn--inline-loading" : ""}`} disabled={!canPauseAll || allLoadingFlag !== "none"} onClick={stopAllTasks}>
                        {allLoadingFlag === "stop" ? <Icon icon="mdi:loading" className="tx-btn-load-ic" /> : null}
                        全部暂停
                    </button>
                    <button type="button" className="tx-btn" disabled={!canResumeAll || allLoadingFlag !== "none"} onClick={startAllTasks}>
                        全部开始
                    </button>
                    <button type="button" className="tx-btn tx-btn--danger" disabled={!canCancelAll || allLoadingFlag !== "none"} onClick={cancelAllTasks}>
                        全部取消
                    </button>
                </div>
                <span className="grow" />
                <button type="button" className="clean-btn rounded px-2 py-1 shrink-0" onClick={cleanFinishedTasks}>
                    清理已完成
                </button>
            </div>
            {totalCount === 0 ? <div className="empty-tip px-3 pb-3 text-xs">暂无传输任务</div> : null}
            {totalCount !== 0 ? (
                <div className="transfers-list flex flex-col gap-2 overflow-auto px-3 pb-3 pr-2">
                    {taskItems.map((item) => (
                        <SftpTransferItem key={item.id} item={item} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
