"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GlobalButton from "@/components/GlobalButton";
import Icon from "@/components/Icon";
import ServerTreeRow from "@/components/ServerTreeRow";
import SystemInput from "@/components/SystemInput";
import { useLocalStore, RUNTIME_CACHE_FILE } from "@/stores/localstore";
import { useServerDataStore, type RowData, type ServerGroupModel } from "@/stores/serverData";
import { treeForEach } from "@/utils";
import { dragListener } from "@/utils/project";
import { useReactBodyEventStore } from "@/stores/reactBodyEvent";
import "./index.scss";

export type CopyData = {
    type: "copy" | "cut";
    data: RowData[];
};

export default function ServerTree() {
    const serverRootGroup = useServerDataStore((state) => state.serverRootGroup);
    const writeCache = useLocalStore((state) => state.writeCache);
    const readCache = useLocalStore((state) => state.readCache);
    const { register } = useReactBodyEventStore();
    const [keyword, setKeyword] = useState("");
    const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
    const [selectedRawData, setSelectedRawData] = useState<Set<RowData>>(new Set());
    const [copyData, setCopyData] = useState<CopyData>({ type: "copy", data: [] });
    const serverTreeBodyRef = useRef<HTMLDivElement | null>(null);
    const blankContextMenuRef = useRef<((event: React.MouseEvent) => void) | null>(null);

    const showServerCount = useMemo(() => {
        let count = 0;
        treeForEach<ServerGroupModel>(serverRootGroup, (group: ServerGroupModel) => {
            count += group.servers.length;
        });
        return count;
    }, [serverRootGroup]);

    useEffect(() => {
        setExpandedGroupIds((prev) => new Set(prev).add(serverRootGroup.id));
        readCache<string[]>("EXPANDED_GROUP_IDS", RUNTIME_CACHE_FILE).then((data) => {
            if (data) setExpandedGroupIds(new Set(data));
        });
        return register("click", () => {
            setSelectedRawData(new Set());
            return false;
        });
    }, [readCache, register, serverRootGroup.id]);

    useEffect(() => {
        void writeCache("EXPANDED_GROUP_IDS", Array.from(expandedGroupIds), RUNTIME_CACHE_FILE);
    }, [expandedGroupIds, writeCache]);

    useEffect(() => {
        let cleanup: (() => void) | undefined;
        // Tauri 原生拖拽不会自动派发 DOM dragover/drop，沿用 Vue 版桥接保证树行拖放目标能被命中。
        void dragListener(() => Array.from(serverTreeBodyRef.current?.querySelectorAll<HTMLElement>(".server-tree-row") ?? [])).then((unlisten) => {
            cleanup = unlisten;
        });
        return () => cleanup?.();
    }, []);

    function expandAll() {
        const next = new Set<string>();
        treeForEach<ServerGroupModel>(serverRootGroup, (group: ServerGroupModel) => {
            next.add(group.id);
        });
        setExpandedGroupIds(next);
    }

    function collapseAll() {
        setExpandedGroupIds(new Set([serverRootGroup.id]));
    }

    const setBlankContextMenu = useCallback((handler: ((event: React.MouseEvent) => void) | null) => {
        blankContextMenuRef.current = handler;
    }, []);

    function openBlankContextMenu(event: React.MouseEvent<HTMLDivElement>) {
        blankContextMenuRef.current?.(event);
    }

    return (
        <div className="ServerTree server-tree-root h-full">
            <section className="server-tree-page">
                <header className="server-tree-header">
                    <div className="server-tree-title-block">
                        <p className="server-tree-kicker">Server Tree</p>
                        <h1 className="server-tree-title">服务器连接</h1>
                    </div>
                    <div className="server-tree-actions">
                        <button className="server-tree-action" type="button" onClick={expandAll}>
                            全部展开
                        </button>
                        <button className="server-tree-action" type="button" onClick={collapseAll}>
                            全部收起
                        </button>
                    </div>
                </header>

                <div className="server-tree-toolbar">
                    <label className="server-tree-search">
                        <Icon icon="si:search-alt-fill" className="server-tree-search-icon" />
                        <SystemInput value={keyword} onChange={setKeyword} type="search" placeholder="搜索分组、名称、IP 或用户" />
                    </label>
                    <span className="server-tree-count">{showServerCount} 台服务器</span>
                </div>

                <div className="server-tree-card" onContextMenu={openBlankContextMenu}>
                    <div className="server-tree-head" aria-hidden="true">
                        <span>名称</span>
                        <span>IP</span>
                        <span>端口</span>
                        <span>用户</span>
                        <span>创建时间</span>
                    </div>
                    <div className="server-tree-body" ref={serverTreeBodyRef}>
                        <ServerTreeRow
                            row={serverRootGroup}
                            level={0}
                            selectedRawData={selectedRawData}
                            setSelectedRawData={setSelectedRawData}
                            expandedGroupIds={expandedGroupIds}
                            setExpandedGroupIds={setExpandedGroupIds}
                            copyData={copyData}
                            setCopyData={setCopyData}
                            searchKeyword={keyword}
                            setBlankContextMenu={setBlankContextMenu}
                        />
                    </div>
                </div>
            </section>
            <GlobalButton bts={["setting", "theme", "themeMode"]} settingTab="server" />
        </div>
    );
}
