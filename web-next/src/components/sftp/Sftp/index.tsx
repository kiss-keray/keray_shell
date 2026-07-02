"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import LayoutColumnResizer from "@/components/layout/LayoutColumnResizer";
import SftpDirTree from "@/components/sftp/SftpDirTree";
import SftpFileTable from "@/components/sftp/SftpFileTable";
import SftpToolbar from "@/components/sftp/SftpToolbar";
import SftpTransfersTab from "@/components/sftp/SftpTransfersTab";
import { SftpContext } from "@/components/sftp/context";
import { createRootFile, findTreeItem, type FileStoreItem } from "@/components/sftp/model";
import useBus, { SftpProcessEventKey } from "@/hooks/useBus";
import type { ChannelInstance } from "@/stores/channelInstances";
import { useConfigStore } from "@/stores/config";
import { useDownloadStore } from "@/stores/downloadStore";
import "./index.scss";

export type SftpProps = {
    server: ChannelInstance;
    writeTerminal?: (value: string) => void;
    className?: string;
};

type SftpSnapshot = {
    rootFile: FileStoreItem;
    activeItemId: string;
};

const TREE_WIDTH_MIN = 120;
const TREE_WIDTH_MAX = 520;

function consumeSnapshot(server: ChannelInstance): { rootFile: FileStoreItem; activeItem: FileStoreItem } {
    const snapshot = server.snapshot.sftpData as SftpSnapshot | undefined;
    if (!snapshot) {
        const rootFile = createRootFile();
        return { rootFile, activeItem: rootFile };
    }
    delete server.snapshot.sftpData;
    const rootFile = { ...snapshot.rootFile };
    return {
        rootFile,
        activeItem: findTreeItem(rootFile, snapshot.activeItemId) ?? rootFile,
    };
}

export default function Sftp({ server, writeTerminal, className }: SftpProps) {
    const initial = useMemo(() => consumeSnapshot(server), [server]);
    const activeCount = useDownloadStore((state) => state.activeCount);
    const sftpTreeWidthPx = useConfigStore((state) => state.sftpTreeWidthPx);
    const [activeTab, setActiveTab] = useState<"files" | "downloads">("files");
    const [rootFile, setRootFile] = useState<FileStoreItem>(initial.rootFile);
    const [activeItem, _setActiveItem] = useState<FileStoreItem>(initial.activeItem);
    const [process, setProcess] = useState(0);
    const { on } = useBus();

    const refreshTree = useCallback(() => {
        // todo: 刷新树
        setRootFile((v) => ({ ...v }));
    }, [setRootFile]);

    // 更新activeItem时强制改掉activeItem在树结构中的引用
    const setActiveItem = useCallback(
        (item: FileStoreItem) => {
            const itemNewRef = { ...item };
            const parent = itemNewRef.parent;
            if (!parent) return;
            parent.children = parent.children?.map((child) => (child.id === item.id ? itemNewRef : child)) || [];
            _setActiveItem(itemNewRef);
        },
        [_setActiveItem],
    );

    useEffect(() => {
        server.snapshotFn.sftpData = () =>
            ({
                rootFile,
                activeItemId: activeItem.id,
            }) satisfies SftpSnapshot;
    }, [activeItem.id, rootFile, server]);

    useEffect(() => on(SftpProcessEventKey, (value) => setProcess(value)), [on]);

    const contextValue = useMemo(
        () => ({
            server,
            writeTerminal,
            rootFile,
            activeItem,
            setActiveItem,
            refreshTree,
        }),
        [activeItem, rootFile, server, writeTerminal, refreshTree, setActiveItem],
    );

    return (
        <SftpContext.Provider value={contextValue}>
            <div className={className ? `Sftp sftp-panel relative flex flex-col h-full ${className}` : "Sftp sftp-panel relative flex flex-col h-full"}>
                <div className="tabs shrink-0 flex items-center gap-1">
                    <button type="button" className={`tab${activeTab === "files" ? " on" : ""}`} onClick={() => setActiveTab("files")}>
                        文件
                    </button>
                    <button type="button" className={`tab${activeTab === "downloads" ? " on" : ""}`} onClick={() => setActiveTab("downloads")}>
                        传输 <span className="tab-badge">{activeCount}</span>
                    </button>
                    <div className="sftp-process">
                        <div className="process-container" style={{ display: process && process < 100 ? undefined : "none" }}>
                            <div className="process-bar" style={{ width: `${process}%` }} />
                        </div>
                    </div>
                </div>

                <div className="files-view flex grow min-h-0 flex-col" style={{ display: activeTab === "files" ? undefined : "none" }}>
                    <SftpToolbar />
                    <div className="main flex grow min-h-0 overflow-hidden">
                        <SftpDirTree width={sftpTreeWidthPx} />
                        <LayoutColumnResizer
                            modelValue={sftpTreeWidthPx}
                            min={TREE_WIDTH_MIN}
                            max={TREE_WIDTH_MAX}
                            // Vue 版拖拽时直接 v-model 到 Pinia ref，不触发配置保存事件。
                            onChange={(value) => useConfigStore.setState({ sftpTreeWidthPx: value })}
                        />
                        <SftpFileTable />
                    </div>
                </div>
                <SftpTransfersTab style={{ display: activeTab === "downloads" ? undefined : "none" }} />
            </div>
        </SftpContext.Provider>
    );
}
