"use client";

import { useServerOverviewPolling } from "@/hooks/useServerOverviewPolling";
import { useChannelInstancesStore, isChannelInstance } from "@/stores/channelInstances";
import ServerDisk from "@/components/ssh/ServerDisk";
import ServerMessage from "@/components/ssh/ServerMessage";
import ServerResource from "@/components/ssh/ServerResource";
import "./index.scss";

export default function ServerOverviewPanel() {
    useServerOverviewPolling();
    const selectSession = useChannelInstancesStore((state) => state.selectSession);
    const instance = selectSession && isChannelInstance(selectSession) ? selectSession : null;
    const overview = instance?.overview;

    return (
        <div className="ServerOverviewPanel overview-root">
            {instance && overview ? (
                <>
                    {overview.error ? <div className="ov-err">{overview.error}</div> : null}
                    <ServerMessage />
                    <ServerResource />
                    <div className="disk-scroll-region">
                        <ServerDisk />
                    </div>
                </>
            ) : (
                <div className="empty">暂无连接的服务器</div>
            )}
        </div>
    );
}
