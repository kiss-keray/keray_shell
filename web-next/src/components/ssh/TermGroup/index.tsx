"use client";

import { invoke } from "@tauri-apps/api/core";
import { TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Term from "@/components/ssh/Term";
import { useChannelInstancesStore, type ChannelInstance, type ChannelInstanceGroup } from "@/stores/channelInstances";
import { GroupLayout, type LayoutRect } from "@/components/ssh/term_grpup";
import "./index.scss";

export type TermGroupProps = {
    group: ChannelInstanceGroup;
};

function statusLabel(status: ChannelInstance["status"]) {
    if (status === "connected") return "已连接";
    if (status === "connecting") return "连接中";
    return "未连接";
}

export default function TermGroup({ group }: TermGroupProps) {
    const container = useRef<HTMLDivElement | null>(null);
    const groupLayoutInstance = useRef<GroupLayout | null>(null);
    const [layoutMap, setLayoutMap] = useState<Record<string, LayoutRect>>({});
    const [selectTermId, setSelectTermId] = useState<string | null>(group.instances[0]?.sessionId ?? null);
    const selectTermIdRef = useRef(selectTermId);
    const channelStore = useChannelInstancesStore();

    selectTermIdRef.current = selectTermId;

    function applyLayouts(layouts: LayoutRect[] | undefined) {
        if (!layouts) return;
        setLayoutMap(
            layouts.reduce<Record<string, LayoutRect>>(
                (acc, layout: LayoutRect) => {
                    acc[layout.id] = layout;
                    return acc;
                },
                {},
            ),
        );
    }

    function ensureLayout(reset = false) {
        const el = container.current;
        const selectedId = selectTermIdRef.current;
        if (!el || !selectedId) return;
        if (reset || !groupLayoutInstance.current) {
            const ow = el.clientWidth;
            // 与 Vue 版保持一致：展开块按容器宽度派生，避免回退到算法默认 1000x800。
            groupLayoutInstance.current = new GroupLayout({
                selectedBoxId: selectedId,
                targetLandscapeRatio: 1.2,
                expandedWidth: ow / 2,
                expandedHeight: (ow / 2) * 0.8,
            });
            applyLayouts(groupLayoutInstance.current.layoutInit(group.instances, ow, el.clientHeight));
            return;
        }
        applyLayouts(groupLayoutInstance.current.layoutUpdate(el.clientWidth, el.clientHeight));
    }

    function closeInstance(item: ChannelInstance) {
        void invoke("close_term", { sid: item.sessionId });
        group.instances.remove(item);
        if (group.instances.length === 0) {
            channelStore.del(group);
            return;
        }
        if (item.sessionId === selectTermId) setSelectTermId(group.instances[0].sessionId);
        ensureLayout(true);
    }

    useEffect(() => {
        ensureLayout(true);
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void getCurrentWindow()
            .listen(TauriEvent.WINDOW_RESIZED, () => {
                // Vue 版 resize 时调用 initLayout，会重新生成随机块规格并重建布局。
                ensureLayout(true);
            })
            .then((fn) => {
                if (disposed) {
                    fn();
                    return;
                }
                unlisten = fn;
            });
        return () => {
            disposed = true;
            unlisten?.();
        };
        // 组内实例是可变数组，layout 更新由显式 close/select 和窗口 resize 触发。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [group.instances.length]);

    useEffect(() => {
        const el = container.current;
        if (!el || !selectTermId) return;
        if (!groupLayoutInstance.current) {
            ensureLayout(true);
            return;
        }
        applyLayouts(groupLayoutInstance.current.changeSelectedBoxId(selectTermId, el.clientWidth, el.clientHeight));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectTermId]);

    return (
        <div ref={container} className="TermGroup term-group">
            {group.instances.map((instance) => (
                <div
                    key={instance.sessionId}
                    style={{
                        left: `${layoutMap[instance.sessionId]?.x ?? 0}px`,
                        top: `${layoutMap[instance.sessionId]?.y ?? 0}px`,
                        width: `${layoutMap[instance.sessionId]?.width ?? 0}px`,
                        height: `${layoutMap[instance.sessionId]?.height ?? 0}px`,
                    }}
                    className={`child-box${selectTermId === instance.sessionId ? " active" : ""}`}
                    onClick={() => setSelectTermId(instance.sessionId)}
                >
                    <div className="child-box-header" title={`${instance.server.name} · ${instance.server.user}@${instance.server.ip}:${instance.server.port}`}>
                        <div className="child-box-name">{instance.server.name}</div>
                        <div className="child-box-meta">
                            {instance.server.user}@{instance.server.ip}:{instance.server.port}
                        </div>
                        <div className={`child-box-status ${instance.status}`}>
                            <i className="child-box-status-dot" aria-hidden="true" />
                            {statusLabel(instance.status)}
                        </div>
                        <Icon
                            icon="si:close-duotone"
                            className="pointer icon"
                            onClick={(event) => {
                                event.stopPropagation();
                                closeInstance(instance);
                            }}
                        />
                    </div>
                    <Term server={instance} groupId={group.sessionId} groupActive={selectTermId === instance.sessionId} />
                </div>
            ))}
        </div>
    );
}
