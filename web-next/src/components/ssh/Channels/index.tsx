"use client";

import { useChannelInstancesStore, type ChannelData } from "@/stores/channelInstances";
import "./index.scss";

export type ChannelsProps = {
    children: (server: ChannelData) => React.ReactNode;
};

export default function Channels({ children }: ChannelsProps) {
    const instances = useChannelInstancesStore((state) => state.instances);
    const selectSessionId = useChannelInstancesStore((state) => state.selectSessionId);

    return (
        <div className="Channels w-full h-full relative">
            {instances.map((server) => (
                <div key={server.sessionId} className={`channel${selectSessionId === server.sessionId ? " active" : ""}`} style={{ zIndex: server.zindex }}>
                    {children(server)}
                </div>
            ))}
        </div>
    );
}
