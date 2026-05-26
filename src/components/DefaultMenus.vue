<script setup lang="ts">
import DefaultMenuItems from "./DefaultMenuItems.vue";
import type { MenuItem } from "./DefaultMenuItems.vue";

const props = defineProps({
    menus: {
        type: Array as PropType<MenuItem[]>,
        required: true,
    },
    pos: {
        type: Object,
        required: true,
    },
});

const domPosition = reactive({
    x: -9999,
    y: -9999,
});
const root = ref();

const emits = defineEmits(["close"]);

watch(
    () => props.pos,
    () => {
        void schedulePosition();
    },
);

watch(
    () => props.menus,
    () => {
        void schedulePosition();
    },
    { deep: true },
);

async function schedulePosition() {
    await nextTick();
    requestAnimationFrame(() => {
        computedPosition();
    });
}

function computedPosition() {
    const el = root.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { width, height } = rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    const max_x = vw - width - pad;
    const max_y = vh - height - pad;
    let x = props.pos.x + 10;
    let y = Math.min(props.pos.y, max_y);
    if (x > max_x) {
        x = props.pos.x - width;
    }
    x = Math.max(pad, Math.min(x, max_x));
    y = Math.max(pad, Math.min(y, max_y));
    domPosition.x = x;
    domPosition.y = y;
}

onMounted(() => {
    void schedulePosition();
});
</script>

<template>
    <div class="menu-box">
        <div ref="root" class="menu-module" :style="{ left: domPosition.x + 'px', top: domPosition.y + 'px' }" @mousedown.stop @contextmenu.prevent>
            <DefaultMenuItems :items="menus" @close="emits('close')" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.menu-module {
    min-width: 160px;
    max-width: min(360px, calc(100vw - 16px));
    position: fixed;
    z-index: 2100;
    padding: 4px 0;
    font-size: var(--font-size-md);
    line-height: 1.35;
    border-radius: 6px;
}
</style>
