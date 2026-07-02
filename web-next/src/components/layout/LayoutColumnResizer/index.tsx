"use client";

import "./index.scss";

export type LayoutColumnResizerProps = {
    modelValue: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
};

export default function LayoutColumnResizer({ modelValue, min, max, onChange }: LayoutColumnResizerProps) {
    function onPointerDown(e: React.MouseEvent<HTMLDivElement>) {
        e.preventDefault();
        if (e.button !== 0) return;
        const startX = e.clientX;
        const startW = modelValue;
        const prevCursor = document.body.style.cursor;
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";

        function onMove(ev: MouseEvent) {
            if (ev.buttons === 0) {
                onUp();
                return;
            }
            const delta = ev.clientX - startX;
            const next = startW + delta;
            onChange(Math.min(max, Math.max(min, next)));
        }
        function onUp() {
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevUserSelect;
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }

    return <div className="LayoutColumnResizer layout-column-resizer" role="separator" aria-orientation="vertical" aria-valuenow={modelValue} aria-valuemin={min} aria-valuemax={max} tabIndex={0} title="拖动调整宽度" onMouseDown={onPointerDown} />;
}
