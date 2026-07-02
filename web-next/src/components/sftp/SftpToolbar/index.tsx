"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import SystemInput from "@/components/SystemInput";
import { useSftpContext } from "@/components/sftp/context";
import useBus, { DirectRemotePathEventKey, DownloadMenuOpenEventKey, RefreshFileListEventKey, UploadFileEventKey } from "@/hooks/useBus";
import "./index.scss";

export default function SftpToolbar() {
    const { server, activeItem } = useSftpContext();
    const { emit } = useBus();
    const [historyOpen, setHistoryOpen] = useState(false);
    const [pathHistory, setPathHistory] = useState<string[]>([]);
    const [pathDraft, setPathDraft] = useState(activeItem.id);
    const historyMounted = useRef(false);

    useEffect(() => {
        setPathDraft(activeItem.id);
        if (!historyMounted.current) {
            historyMounted.current = true;
            return;
        }
        setPathHistory((prev) => [activeItem.id, ...prev.filter((item) => item !== activeItem.id)]);
    }, [activeItem.id]);

    function applyPath(path = pathDraft) {
        emit(DirectRemotePathEventKey, { sid: server.sessionId, path });
    }

    function selectHistory(path: string) {
        applyPath(path);
        setHistoryOpen(false);
    }

    return (
        <div className="SftpToolbar toolbar shrink-0 flex items-center gap-2 px-2 py-2">
            <SystemInput
                value={pathDraft}
                onChange={setPathDraft}
                className="path-input grow min-w-0 rounded px-2 py-1 text-sm outline-none"
                placeholder="路径"
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        applyPath();
                    }
                }}
            />
            <div className="actions flex items-center gap-1 shrink-0">
                <div className="relative">
                    <button type="button" className="tb-btn" onClick={() => setHistoryOpen((prev) => !prev)}>
                        历史
                    </button>
                    {historyOpen ? (
                        <div className="hist-pop absolute right-0 top-full z-20 mt-1 max-h-48 min-w-[200px] overflow-auto rounded py-1 text-sm">
                            {pathHistory.map((historyPath) => (
                                <button key={historyPath} type="button" className="hist-item block w-full px-3 py-1.5 text-left" onClick={() => selectHistory(historyPath)}>
                                    {historyPath}
                                </button>
                            ))}
                            {!pathHistory.length ? <p className="hist-empty px-3 py-2">暂无记录</p> : null}
                        </div>
                    ) : null}
                </div>
                <button type="button" className="icon-btn" title="刷新" onClick={() => emit(RefreshFileListEventKey)}>
                    <Icon icon="mdi:refresh" className="text-lg" />
                </button>
                <div className="relative">
                    <button type="button" className="icon-btn" title="上传">
                        <Icon icon="mdi:upload" className="text-lg" onClick={() => emit(UploadFileEventKey)} />
                    </button>
                </div>
                <button type="button" className="icon-btn" title="下载" onClick={() => emit(DownloadMenuOpenEventKey)}>
                    <Icon icon="mdi:download" className="text-lg" />
                </button>
            </div>
        </div>
    );
}
