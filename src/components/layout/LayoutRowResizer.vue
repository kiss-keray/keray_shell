<script setup>
const props = defineProps({
    /** 下方（或后段）区域高度 px */
    modelValue: {
        type: Number,
        required: true
    },
    /** 外层 flex 列容器，用于计算可用高度 */
    container: {
        type: Object,
        default: null
    },
    minFirst: {
        type: Number,
        default: 120
    },
    minSecond: {
        type: Number,
        default: 140
    },
    handlePx: {
        type: Number,
        default: 6
    }
});

const emit = defineEmits(["update:modelValue"]);

function containerEl() {
    const c = props.container;
    if (!c) return null;
    return typeof c === "object" && "value" in c ? c.value : null;
}

function clamp(h) {
    const el = containerEl();
    if (!el) return h;
    const total = el.getBoundingClientRect().height;
    const maxSecond = Math.max(props.minSecond, total - props.minFirst - props.handlePx);
    return Math.max(props.minSecond, Math.min(maxSecond, h));
}

let resizeObserver;
let dragging = false;
let moveHandler;
let upHandler;

function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", moveHandler);
    window.removeEventListener("mouseup", upHandler, true);
}

function onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    const startY = e.clientY;
    const startBottom = props.modelValue;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";

    moveHandler = (ev) => {
        if (!dragging) return;
        const delta = ev.clientY - startY;
        emit("update:modelValue", clamp(startBottom - delta));
    };
    upHandler = () => {
        endDrag();
    };
    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("mouseup", upHandler, true);
}

watch(
    () => containerEl(),
    (el) => {
        if (!resizeObserver) {
            resizeObserver = new ResizeObserver(() => {
                emit("update:modelValue", clamp(props.modelValue));
            });
        }
        resizeObserver.disconnect();
        if (el) resizeObserver.observe(el);
    },
    { immediate: true }
);

onBeforeUnmount(() => {
    endDrag();
    resizeObserver?.disconnect();
});
</script>

<template>
    <div class="layout-row-resizer" role="separator" aria-orientation="horizontal" :aria-valuenow="modelValue"
        tabindex="0" title="拖动调整高度" @mousedown="onPointerDown" />
</template>
