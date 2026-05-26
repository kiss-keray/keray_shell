<script setup>
const props = defineProps({
    modelValue: {
        type: Number,
        required: true
    },
    min: {
        type: Number,
        required: true
    },
    max: {
        type: Number,
        required: true
    }
});

const emit = defineEmits(["update:modelValue"]);

function onPointerDown(e) {
    e.preventDefault();
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startW = props.modelValue;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev) {
        if (ev.buttons === 0) {
            onUp();
            return;
        }
        const delta = ev.clientX - startX;
        const next = startW + delta;
        emit("update:modelValue", Math.min(props.max, Math.max(props.min, next)));
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
</script>

<template>
    <div class="layout-column-resizer" role="separator" aria-orientation="vertical" :aria-valuenow="modelValue"
        :aria-valuemin="min" :aria-valuemax="max" tabindex="0" title="拖动调整宽度" @mousedown="onPointerDown" />
</template>
