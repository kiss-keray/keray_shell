import type { UnlistenFn } from "@tauri-apps/api/event";
import { type } from "@tauri-apps/plugin-os";

/**
 * Windows WebView2 内部拖动兼容层。
 *
 * Windows 下原生 HTML5 拖动可能无法继续触发 dragover、dragleave 和 drop，
 * 因此这里使用 PointerEvent 跟踪鼠标，并向现有 DOM 主动派发对应的 DragEvent。
 * 组件原有的 @dragstart、@dragend、@dragover、@dragleave、@drop 无需改写。
 */

/** 返回当前参与拖动的 DOM。使用函数而不是静态数组，以适配 Vue 列表更新。 */
type DragDomProvider = () => HTMLElement[];

/** 一次指针拖动过程中的运行状态。 */
type PointerDragState = {
    /** 只处理发起本次拖动的指针。 */
    pointerId: number;
    /** 设置了 draggable="true" 的实际拖动源。 */
    source: HTMLElement;
    /** pointerdown 时的坐标，用于判断是否达到拖动阈值。 */
    startX: number;
    startY: number;
    /** 指针最新坐标，用于构造模拟的 DragEvent。 */
    clientX: number;
    clientY: number;
    /** 是否已越过阈值并派发 dragstart。 */
    started: boolean;
    /** 当前指针所在的已注册拖放目标。 */
    target: HTMLElement | null;
};

/** 同一窗口可能有多个组件注册拖动区域，因此统一集中管理。 */
const windowsDragDomProviders = new Set<DragDomProvider>();
/** 标记本模块创建的事件，避免被原生拖动拦截器再次拦截。 */
const simulatedDragEvents = new WeakSet<Event>();
/** 模拟拖动期间挂到 html 上的全局光标状态类。 */
const windowsDragCursorClass = "windows-pointer-dragging";
/** 当前窗口同一时间只维护一个拖动状态。 */
let pointerDragState: PointerDragState | null = null;
/** 防止多个组件重复安装 document 级监听。 */
let pointerDragListenersMounted = false;
/** 拖动结束后短暂屏蔽浏览器补发的 click，避免误触行点击。 */
let suppressPointerDragClickUntil = 0;

/** 每次使用时重新获取 DOM，保证新增、删除或重渲染后的节点也能参与拖动。 */
function allDragDoms(): HTMLElement[] {
    return Array.from(windowsDragDomProviders).flatMap((getDoms) => getDoms());
}

/**
 * 从事件命中节点向上查找真正的 draggable 拖动源。
 * 注册节点可以就是拖动源，也可以是拖动源内部用于显示的一层节点。
 */
function registeredDragSource(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const source = target.closest<HTMLElement>('[draggable="true"]');
    if (!source) return null;
    return allDragDoms().some((dom) => dom === source || source.contains(dom)) ? source : null;
}

/** 根据指针坐标查找最靠近命中节点的已注册拖放目标。 */
function dragTargetAt(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y);
    if (!(hit instanceof Element)) return null;
    const dragDoms = new Set(allDragDoms());
    let element: Element | null = hit;
    while (element) {
        if (element instanceof HTMLElement && dragDoms.has(element)) return element;
        element = element.parentElement;
    }
    return null;
}

/** 向原有事件处理器派发一个带当前指针坐标的模拟 DragEvent。 */
function dispatchSimulatedDragEvent(target: HTMLElement, eventType: "dragstart" | "dragend" | "dragover" | "dragleave" | "drop"): boolean {
    const state = pointerDragState;
    if (!state) return false;
    const event = new DragEvent(eventType, {
        bubbles: true,
        cancelable: true,
        clientX: state.clientX,
        clientY: state.clientY,
    });
    simulatedDragEvents.add(event);
    return target.dispatchEvent(event);
}

/**
 * 更新当前拖放目标：留在同一目标时持续派发 dragover；
 * 目标改变时，依次向旧目标派发 dragleave、向新目标派发 dragover。
 */
function updatePointerDragTarget(event: PointerEvent) {
    const state = pointerDragState;
    if (!state?.started) return;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
    const target = dragTargetAt(event.clientX, event.clientY);
    if (target === state.target) {
        if (target) dispatchSimulatedDragEvent(target, "dragover");
        return;
    }
    if (state.target) dispatchSimulatedDragEvent(state.target, "dragleave");
    state.target = target;
    if (target) dispatchSimulatedDragEvent(target, "dragover");
}

/** 移除仅在一次拖动期间使用的 window 级指针监听。 */
function removeActivePointerDragListeners() {
    window.removeEventListener("pointermove", handlePointerDragMove);
    window.removeEventListener("pointerup", handlePointerDragEnd);
    window.removeEventListener("pointercancel", cancelPointerDrag);
    window.removeEventListener("blur", cancelPointerDrag);
}

/** 结束本次拖动、恢复指针捕获并清空运行状态。 */
function finishPointerDrag(emitDragEnd: boolean) {
    const state = pointerDragState;
    if (!state) return;
    removeActivePointerDragListeners();
    if (state.target) dispatchSimulatedDragEvent(state.target, "dragleave");
    if (emitDragEnd && state.started) dispatchSimulatedDragEvent(state.source, "dragend");
    if (state.source.hasPointerCapture(state.pointerId)) {
        state.source.releasePointerCapture(state.pointerId);
    }
    document.documentElement.classList.remove(windowsDragCursorClass);
    pointerDragState = null;
}

/** 跟随指针移动，并在越过阈值后正式开始模拟拖动。 */
function handlePointerDragMove(event: PointerEvent) {
    const state = pointerDragState;
    if (!state || state.pointerId !== event.pointerId) return;
    state.clientX = event.clientX;
    state.clientY = event.clientY;
    if (!state.started) {
        // 保留 5px 移动阈值，避免把普通点击识别成拖动。
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 5) return;
        state.started = true;
        try {
            state.source.setPointerCapture(state.pointerId);
        } catch {
            // WebView 失去指针时继续依赖 window pointerup/blur 清理。
        }
        if (!dispatchSimulatedDragEvent(state.source, "dragstart")) {
            finishPointerDrag(false);
            return;
        }
        // 模拟 DragEvent 不会触发系统原生拖动光标，因此显式切换为抓取状态。
        document.documentElement.classList.add(windowsDragCursorClass);
    }
    event.preventDefault();
    updatePointerDragTarget(event);
}

/** 指针释放时先向当前目标派发 drop，最后向拖动源派发 dragend。 */
function handlePointerDragEnd(event: PointerEvent) {
    const state = pointerDragState;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.started) {
        event.preventDefault();
        updatePointerDragTarget(event);
        if (state.target) dispatchSimulatedDragEvent(state.target, "drop");
        suppressPointerDragClickUntil = performance.now() + 100;
    }
    finishPointerDrag(true);
}

/** 指针取消或窗口失焦时进行兜底清理。 */
function cancelPointerDrag() {
    finishPointerDrag(true);
}

/**
 * 记录可能的拖动起点。
 * 仅响应鼠标主键，并跳过输入控件，避免干扰文本选择和表单操作。
 */
function handlePointerDragStart(event: PointerEvent) {
    if (event.pointerType === "touch" || event.button !== 0 || !event.isPrimary) return;
    const eventTarget = event.target as Element | null;
    if (eventTarget?.closest("input, textarea, select, [contenteditable='true']")) return;
    const source = registeredDragSource(event.target);
    if (!source) return;
    cancelPointerDrag();
    pointerDragState = {
        pointerId: event.pointerId,
        source,
        startX: event.clientX,
        startY: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        started: false,
        target: null,
    };
    window.addEventListener("pointermove", handlePointerDragMove, { passive: false });
    window.addEventListener("pointerup", handlePointerDragEnd);
    window.addEventListener("pointercancel", cancelPointerDrag);
    window.addEventListener("blur", cancelPointerDrag);
}

/**
 * 阻止已注册节点进入 Windows WebView2 的原生 HTML5 拖动流程，
 * 否则原生流程会接管鼠标，导致后续 PointerEvent 无法用于事件模拟。
 */
function blockNativeRegisteredDrag(event: DragEvent) {
    if (simulatedDragEvents.has(event) || !registeredDragSource(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

/** 屏蔽一次拖动完成后浏览器生成的兼容 click。 */
function suppressPointerDragClick(event: MouseEvent) {
    if (performance.now() >= suppressPointerDragClickUntil) return;
    suppressPointerDragClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
}

/** 首个组件注册时安装一次全局监听。 */
function mountWindowsPointerDragListeners() {
    if (pointerDragListenersMounted) return;
    pointerDragListenersMounted = true;
    document.addEventListener("pointerdown", handlePointerDragStart, true);
    document.addEventListener("dragstart", blockNativeRegisteredDrag, true);
    document.addEventListener("dragend", blockNativeRegisteredDrag, true);
    document.addEventListener("click", suppressPointerDragClick, true);
}

/** 最后一个组件注销后移除全局监听。 */
function unmountWindowsPointerDragListeners() {
    if (!pointerDragListenersMounted || windowsDragDomProviders.size > 0) return;
    pointerDragListenersMounted = false;
    cancelPointerDrag();
    document.removeEventListener("pointerdown", handlePointerDragStart, true);
    document.removeEventListener("dragstart", blockNativeRegisteredDrag, true);
    document.removeEventListener("dragend", blockNativeRegisteredDrag, true);
    document.removeEventListener("click", suppressPointerDragClick, true);
}

/** 注册一组动态拖动节点，并返回与 Tauri listen 一致风格的注销函数。 */
function registerWindowsPointerDrag(getDoms: DragDomProvider): UnlistenFn {
    windowsDragDomProviders.add(getDoms);
    mountWindowsPointerDragListeners();
    return () => {
        cancelPointerDrag();
        windowsDragDomProviders.delete(getDoms);
        unmountWindowsPointerDragListeners();
    };
}

/**
 * Windows WebView2 内部拖动兼容层。
 * 自动向原有 DOM 节点模拟 dragstart、dragend、dragover、dragleave、drop，
 * 组件可以继续使用原来的 @drag* 处理器。
 *
 * 非 Windows 系统不会安装任何监听，返回的函数用于在组件卸载时注销。
 *
 * @param getDoms 动态返回拖动源或拖放目标节点
 * @returns 注销函数
 */
export function windowsDragListener(getDoms: DragDomProvider): UnlistenFn {
    if(type() !== "windows") {
        return () => {};
    }
    return registerWindowsPointerDrag(getDoms);
}
