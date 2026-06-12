/** 鼠标点击事件， 但是会忽略点击后鼠标移动的点击事件 */
export default {
    mounted(el: HTMLElement, binding: DirectiveBinding) {
        let startX = 0;
        let startY = 0;
        let dragging = false;
        const threshold = 5; // 容忍的像素范围

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
            if (!dragging) {
                binding.value?.(e);
            }
        };

        (el as any).__sclickHandlers__ = { onMouseDown, onMouseMove, onMouseUp };

        el.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    },

    unmounted(el: HTMLElement) {
        const { onMouseDown, onMouseMove, onMouseUp } = (el as any).__sclickHandlers__ || {};
        el.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        delete (el as any).__sclickHandlers__;
    },
};
