"use client";

import { emitTo } from "@tauri-apps/api/event";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import GlobalButton from "@/components/GlobalButton";
import Icon from "@/components/Icon";
import SystemInput from "@/components/SystemInput";
import {
    CHANNEL_INSTANCE_GROUP_CREATE_EVENT,
    SERVER_TREE_CLICK_SERVER_EVENT,
    useChannelInstancesStore,
    type ChannelInstanceGroupCreatePayload,
    type ServerTreeClickServerPayload,
} from "@/stores/channelInstances";
import { useAppStore } from "@/stores/app";
import { useKeyEventStore } from "@/stores/keyEvent";
import { useServerDataStore, type ServerDataModel, type ServerGroupModel } from "@/stores/serverData";
import { CustomMenusEventKey } from "@/utils/constant";
import type { MenuItem } from "@/components/DefaultMenuItems";
import "./index.scss";

export default function ServerList() {
    const label = useAppStore((state) => state.label);
    const recentlyServerIds = useServerDataStore((state) => state.recentlyServerIds);
    const serverRootGroup = useServerDataStore((state) => state.serverRootGroup);
    const isMultiSelectKey = useKeyEventStore((state) => state.isMultiSelectKey);
    const clearChannels = useChannelInstancesStore((state) => state.clear);
    const [keyword, setKeyword] = useState("");
    const [selectedServers, setSelectedServers] = useState<ServerDataModel[]>([]);

    const recentlyServerData = useMemo(() => {
        return recentlyServerIds.map((id) => useServerDataStore.getState().findServerDataById(id, serverRootGroup)).filter((v): v is ServerDataModel => v !== null);
    }, [recentlyServerIds, serverRootGroup]);

    const groupPathMap = useMemo(() => {
        const map = new Map<string, string>();
        function walk(group: ServerGroupModel, parentPath = "") {
            const currentPath = group.id === "root" ? "/" : `${parentPath === "/" ? "" : parentPath}/${group.name}`;
            map.set(group.id, currentPath);
            group.children.forEach((child) => walk(child, currentPath));
        }
        walk(serverRootGroup);
        return map;
    }, [serverRootGroup]);

    const serverList = useMemo(() => {
        const seen = new Set<string>();
        const list = [...recentlyServerData].reverse().filter((server) => {
            if (seen.has(server.id)) return false;
            seen.add(server.id);
            return true;
        });
        const q = keyword.trim().toLowerCase();
        if (!q) return list;
        return list.filter((server) => {
            const groupPath = (groupPathMap.get(server.groupId) ?? "/").toLowerCase();
            return [server.name, server.ip, String(server.port), server.user, groupPath].some((text) => text.toLowerCase().includes(q));
        });
    }, [keyword, recentlyServerData, groupPathMap]);

    const totalText = keyword.trim() ? `筛选到 ${serverList.length} 台` : `${serverList.length} 台最近连接`;

    function getGroupPath(server: ServerDataModel) {
        return groupPathMap.get(server.groupId) ?? "/";
    }

    function clickServer(server: ServerDataModel) {
        if (isMultiSelectKey) {
            setSelectedServers((prev) => (prev.includes(server) ? prev.filter((item) => item.id !== server.id) : [...prev, server]));
            return;
        }
        clearChannels();
        void openServer(server);
    }

    async function openServer(server: ServerDataModel) {
        await emitTo<ServerTreeClickServerPayload>({ kind: "Window", label }, SERVER_TREE_CLICK_SERVER_EVENT, { id: server.id });
    }

    function cleanRecent() {
        setKeyword("");
        void useServerDataStore.getState().cleanRecentlyServerData();
    }

    function openContextMenu(e: React.MouseEvent, server: ServerDataModel) {
        e.preventDefault();
        e.stopPropagation();
        const menus: MenuItem[] = [
            {
                label: "连接",
                handler: () => {
                    clearChannels();
                    const list = selectedServers.length > 0 ? selectedServers : [server];
                    list.forEach((item) => void openServer(item));
                },
            },
            {
                label: `融合终端(+${selectedServers.length})`,
                handler: () => {
                    clearChannels();
                    void emitTo<ChannelInstanceGroupCreatePayload>({ kind: "Window", label }, CHANNEL_INSTANCE_GROUP_CREATE_EVENT, {
                        ids: selectedServers.map((item) => item.id),
                    });
                },
                disabled: selectedServers.length < 2,
            },
            {
                label: "删除",
                handler: () => {
                    const list = selectedServers.length > 0 ? selectedServers : [server];
                    list.forEach((item) => void useServerDataStore.getState().deleteRecentlyServerData(item));
                },
            },
        ];
        document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
    }

    return (
        <div className="ServerList server-list-root h-full">
            <section className="server-list-page">
                <div className="server-list-shell">
                    <header className="server-list-header">
                        <div>
                            <p className="server-list-kicker">Quick Connect</p>
                            <h1 className="server-list-title">快速连接</h1>
                        </div>
                        <button className="server-list-clear" type="button" disabled={!recentlyServerData.length} onClick={cleanRecent}>
                            清空
                        </button>
                    </header>

                    <div className="server-list-toolbar">
                        <label className="server-list-search">
                            <Icon icon="si:search-alt-fill" className="server-list-search-icon" />
                            <SystemInput value={keyword} onChange={setKeyword} type="search" placeholder="搜索名称、IP、路径或用户" />
                        </label>
                        <span className="server-list-count">{totalText}</span>
                    </div>

                    {serverList.length ? (
                        <div className="server-list-card grow">
                            <div className="server-list-head" aria-hidden="true">
                                <span>服务器</span>
                                <span>分组路径</span>
                                <span>用户</span>
                                <span>地址</span>
                                <span>最后连接时间</span>
                            </div>
                            {serverList.map((server) => (
                                <button
                                    key={server.id}
                                    className={`server-list-row${selectedServers.includes(server) ? " server-list-row-selected" : ""}`}
                                    type="button"
                                    onClick={() => clickServer(server)}
                                    onContextMenu={(event) => openContextMenu(event, server)}
                                >
                                    <span className="server-list-main">
                                        <Icon icon="lucide:server" className="server-list-server-icon" />
                                        <span className="server-list-name">{server.name}</span>
                                    </span>
                                    <span className="server-list-path" title={getGroupPath(server)}>
                                        {getGroupPath(server)}
                                    </span>
                                    <span className="server-list-user">{server.user}</span>
                                    <span className="server-list-host">
                                        {server.ip}:{server.port}
                                    </span>
                                    <span className="server-list-last-connect-time">{server.lastConnectAt ? dayjs(new Date(server.lastConnectAt)).format("YYYY-MM-DD HH:mm:ss") : "--"}</span>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="server-list-empty">
                            <span className="server-list-empty-icon" aria-hidden="true" />
                            <p className="server-list-empty-title">{keyword ? "没有匹配的服务器" : "暂无最近连接"}</p>
                        </div>
                    )}
                </div>
            </section>
            <GlobalButton bts={["serverTree", "setting", "theme", "themeMode"]} />
        </div>
    );
}
