"use client";

import { useEffect, useRef, type RefObject } from "react";
import "./index.scss";

export type LayoutRowResizerProps = {
    /** 下方（或后段）区域高度 px */
    modelValue: number;
    /** 外层 flex 列容器，用于计算可用高度 */
    container?: RefObject<HTMLElement | null> | null;
    minFirst?: number;
    minSecond?: number;
    handlePx?: number;
    onChange: (value: number) => void;
};

export default function LayoutRowResizer({ modelValue, container = null, minFirst = 120, minSecond = 140, handlePx = 6, onChange }: LayoutRowResizerProps) {
    const dragging = useRef(false);
    const moveHandler = useRef<((ev: MouseEvent) => void) | null>(null);
    const upHandler = useRef<(() => void) | null>(null);
    const latestModelValue = useRef(modelValue);
    const latestOnChange = useRef(onChange);

    latestModelValue.current = modelValue;
    latestOnChange.current = onChange;

    function containerEl() {
        return container?.current ?? null;
    }

    function clamp(h: number) {
        const el = containerEl();
        if (!el) return h;
        const total = el.getBoundingClientRect().height;
        const maxSecond = Math.max(minSecond, total - minFirst - handlePx);
        return Math.max(minSecond, Math.min(maxSecond, h));
    }

    function endDrag() {
        if (!dragging.current) return;
        dragging.current = false;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moveHandler.current) window.removeEventListener("mousemove", moveHandler.current);
        if (upHandler.current) window.removeEventListener("mouseup", upHandler.current, true);
    }

    function onPointerDown(e: React.MouseEvent<HTMLDivElement>) {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        const startY = e.clientY;
        const startBottom = modelValue;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "ns-resize";
        moveHandler.current = (ev) => {
            if (!dragging.current) return;
            const delta = ev.clientY - startY;
            onChange(clamp(startBottom - delta));
        };
        upHandler.current = () => endDrag();
        window.addEventListener("mousemove", moveHandler.current);
        window.addEventListener("mouseup", upHandler.current, true);
    }

    useEffect(() => {
        const el = containerEl();
        if (!el) return;
        const resizeObserver = new ResizeObserver(() => latestOnChange.current(clamp(latestModelValue.current)));
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, [container, minFirst, minSecond, handlePx]);

    useEffect(() => {
        // 与 Vue 版保持一致：拖拽监听只在鼠标松开或组件卸载时清理，拖动中的配置更新不能打断手势。
        return () => endDrag();
    }, []);

    return <div className="LayoutRowResizer layout-row-resizer" role="separator" aria-orientation="horizontal" aria-valuenow={modelValue} tabIndex={0} title="拖动调整高度" onMouseDown={onPointerDown} />;
}
