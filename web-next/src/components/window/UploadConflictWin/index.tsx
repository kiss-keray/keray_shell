"use client";

import { emit, TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import { useAppStore } from "@/stores/app";
import {
    UPLOAD_CONFLICT_DATA_EVENT,
    UPLOAD_CONFLICT_RESOLVED_EVENT,
    type UploadConflictAction,
    type UploadConflictResolvedPayload,
    type UploadConflictWindowPayload,
} from "@/utils/window";
import "./index.scss";

export default function UploadConflictWin() {
    const windowInitData = useAppStore((state) => state.windowInitData);
    const [payload, setPayload] = useState<UploadConflictWindowPayload | null>(null);
    const payloadRef = useRef<UploadConflictWindowPayload | null>(null);
    const [applyToAll, setApplyToAll] = useState(false);

    function setCurrentPayload(data: UploadConflictWindowPayload | null) {
        payloadRef.current = data;
        setPayload(data);
    }

    useEffect(() => {
        if (windowInitData) setCurrentPayload(windowInitData as UploadConflictWindowPayload);
    }, [windowInitData]);

    useEffect(() => {
        let unlistenData: (() => void) | null = null;
        let unlistenClose: (() => void) | null = null;
        const currentWindow = getCurrentWindow();
        void currentWindow.listen<UploadConflictWindowPayload>(UPLOAD_CONFLICT_DATA_EVENT, async ({ payload: data }) => {
            setCurrentPayload(data);
        }).then((fn) => {
            unlistenData = fn;
        });
        void currentWindow.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
            const latestPayload = payloadRef.current;
            await emit<UploadConflictResolvedPayload>(UPLOAD_CONFLICT_RESOLVED_EVENT, {
                taskId: latestPayload?.taskId ?? "",
                action: "cancel",
                applyToAll: true,
            });
            await currentWindow.destroy();
        }).then((fn) => {
            unlistenClose = fn;
        });
        return () => {
            unlistenData?.();
            unlistenClose?.();
        };
    }, []);

    async function choose(action: UploadConflictAction) {
        if (!payload) return;
        await emit<UploadConflictResolvedPayload>(UPLOAD_CONFLICT_RESOLVED_EVENT, {
            taskId: payload.taskId,
            action,
            applyToAll,
        });
        if (payload.last || applyToAll) {
            await getCurrentWindow().destroy();
        }
    }

    return (
        <main className="UploadConflictWin upload-conflict-page">
            <section className="upload-conflict-card">
                <header className="upload-conflict-header">
                    <div className="upload-conflict-icon" aria-hidden="true">
                        <Icon icon="lucide:files" />
                    </div>
                    <div className="upload-conflict-heading">
                        <h1 className="upload-conflict-title">远程文件已存在</h1>
                        <p className="upload-conflict-subtitle">上传的文件与远程路径冲突，请选择处理方式。</p>
                    </div>
                </header>

                {payload ? (
                    <div className="upload-conflict-paths">
                        <div className="upload-conflict-path">
                            <span className="upload-conflict-path-label">本地</span>
                            <p className="upload-conflict-path-value" title={payload.localPath}>
                                {payload.localPath}
                            </p>
                        </div>
                        <div className="upload-conflict-path">
                            <span className="upload-conflict-path-label">远程</span>
                            <p className="upload-conflict-path-value" title={payload.remotePath}>
                                {payload.remotePath}
                            </p>
                        </div>
                    </div>
                ) : null}

                <label className="upload-conflict-apply">
                    <input checked={applyToAll} onChange={(event) => setApplyToAll(event.target.checked)} type="checkbox" />
                    <span>应用到全部冲突文件</span>
                </label>

                <footer className="upload-conflict-actions">
                    <button type="button" className="upload-conflict-btn secondary" onClick={() => void choose("skip")}>
                        跳过
                    </button>
                    <button type="button" className="upload-conflict-btn" onClick={() => void choose("copy")}>
                        保留副本
                    </button>
                    <button type="button" className="upload-conflict-btn primary" onClick={() => void choose("overwrite")}>
                        覆盖
                    </button>
                </footer>
            </section>
        </main>
    );
}
