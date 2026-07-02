"use client";

import { useEffect } from "react";
import GlobalButton from "@/components/GlobalButton";
import LayoutColumnResizer from "@/components/layout/LayoutColumnResizer";
import Channels from "@/components/ssh/Channels";
import ServerOverviewPanel from "@/components/ssh/ServerOverviewPanel";
import ShellInstance from "@/components/ssh/ShellInstance";
import Term from "@/components/ssh/Term";
import TermGroup from "@/components/ssh/TermGroup";
import { isChannelInstance, useChannelInstancesStore } from "@/stores/channelInstances";
import { useAppStore } from "@/stores/app";
import { useConfigStore } from "@/stores/config";
import "./index.scss";

const OVERVIEW_MIN = 200;
const OVERVIEW_MAX = 480;

export default function DefaultLayout() {
    const selectSession = useChannelInstancesStore((state) => state.selectSession);
    const showOverviewPanel = useAppStore((state) => state.showOverviewPanel);
    const overviewWidthPx = useConfigStore((state) => state.overviewWidthPx);

    useEffect(() => {
        document.documentElement.classList.add("default");
    }, []);

    return (
        <div className="DefaultLayout w-full h-full relative flex flex-row default-layout">
            {selectSession && isChannelInstance(selectSession) ? (
                <>
                    <div style={{ display: showOverviewPanel ? undefined : "none", width: `${overviewWidthPx}px` }}>
                        <ServerOverviewPanel />
                    </div>
                    <div style={{ display: showOverviewPanel ? undefined : "none" }}>
                        <LayoutColumnResizer
                            modelValue={overviewWidthPx}
                            min={OVERVIEW_MIN}
                            max={OVERVIEW_MAX}
                            // Vue 版拖拽时直接 v-model 到 Pinia ref，不触发配置保存事件。
                            onChange={(value) => useConfigStore.setState({ overviewWidthPx: value })}
                        />
                    </div>
                </>
            ) : null}
            <div className="flex flex-col grow min-w-0 right-box">
                <ShellInstance />
                <Channels>{(server) => (isChannelInstance(server) ? <Term server={server} /> : <TermGroup group={server} />)}</Channels>
            </div>
            <GlobalButton />
        </div>
    );
}
