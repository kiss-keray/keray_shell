import { type RefObject, useEffect, useRef } from "react";

/** 鼠标点击事件， 但是会忽略点击后鼠标移动的点击事件 */
export function useSClick<T extends HTMLElement>(ref: RefObject<T | null>, handler?: (event: MouseEvent) => void, threshold = 5) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof window === "undefined") return;
        let startX = 0;
        let startY = 0;
        let dragging = false;

        const onMouseDown = (e: MouseEvent) => {
            startX = e.clientX;
            startY = e.clientY;
            dragging = false;
        };

        const onMouseMove = (e: MouseEvent) => {
            if (Math.abs(e.clientX - startX) > threshold || Math.abs(e.clientY - startY) > threshold) {
                dragging = true;
            }
        };

        const onMouseUp = (e: MouseEvent) => {
            if (!dragging) handlerRef.current?.(e);
        };

        el.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            el.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [ref, threshold]);
}

export default useSClick;
