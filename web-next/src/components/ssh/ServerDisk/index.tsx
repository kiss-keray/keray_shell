"use client";

import { useEffect, useState } from "react";
import { useChannelInstancesStore, isChannelInstance } from "@/stores/channelInstances";
import useBus, { ActiveFileEventKey, DirectRemotePathEventKey } from "@/hooks/useBus";
import "./index.scss";

export default function ServerDisk() {
    const selectSession = useChannelInstancesStore((state) => state.selectSession);
    const instance = selectSession && isChannelInstance(selectSession) ? selectSession : null;
    const [activePath, setActivePath] = useState("/");
    const { emit, on } = useBus();
    const overview = instance?.overview;
    const disks = overview?.disks ?? [];
    const activeDisk =
        activePath === "/"
            ? disks.find((d) => d.path === "/")
            : disks.filter((d) => activePath.startsWith(d.path)).sort((a, b) => b.path.length - a.path.length)[0];

    function onActiveDisk(path: string) {
        setActivePath(path);
        if (instance) emit(DirectRemotePathEventKey, { sid: instance.sessionId, path });
    }

    useEffect(() => {
        return on(ActiveFileEventKey, (event) => {
            if (event.sid !== instance?.sessionId) return;
            setActivePath(event.path);
        });
    }, [instance?.sessionId, on]);

    return (
        <div className="ServerDisk module disk">
            <table className="tbl disk">
                <thead>
                    <tr>
                        <th>路径</th>
                        <th>可用/大小</th>
                    </tr>
                </thead>
                <tbody>
                    {disks.map((d, i) => (
                        <tr key={i} className={d === activeDisk ? "root" : ""} onClick={() => onActiveDisk(d.path)}>
                            <td className="path">{d.path}</td>
                            <td className="disk-cell">
                                <div className="disk-bar" style={{ width: `${d.pct}%` }} />
                                <span className="disk-txt">
                                    {d.avail}/{d.size}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
