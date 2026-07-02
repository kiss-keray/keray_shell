"use client";

import "./index.scss";
import ServerList from "@/components/ServerList";
import DefaultLayout from "@/layout/DefaultLayout";
import { useAppStore } from "@/stores/app";
import { useChannelInstancesStore } from "@/stores/channelInstances";

export default function MainWin() {
    const instances = useChannelInstancesStore((state) => state.instances);
    const isMainWin = useAppStore((state) => state.isMainWin);

    return <main className="MainWin">{instances.length || !isMainWin ? <DefaultLayout /> : <ServerList />}</main>;
}
