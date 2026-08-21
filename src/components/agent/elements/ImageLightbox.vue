<script setup lang="ts">
import { PRIORITY_HIGHEST } from "@/stores/keyEvent";

defineOptions({ name: "AgentImageLightbox" });

const props = defineProps<{
    /** 有值时展示全屏预览；为空则关闭。 */
    src?: string;
    alt?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const visible = computed(() => Boolean(props.src));
let unregisterKey: (() => void) | undefined;

function close() {
    emit("close");
}

// 预览打开时抢走 Escape，避免先关掉输入区弹层或终端焦点。
watch(
    visible,
    (isVisible) => {
        unregisterKey?.();
        unregisterKey = undefined;
        if (!isVisible) return;
        unregisterKey = useKeyEventStore().register((event) => {
            if (event.key !== "Escape") return false;
            close();
            return true;
        }, PRIORITY_HIGHEST);
    },
    { immediate: true },
);

onBeforeUnmount(() => unregisterKey?.());
</script>

<template>
    <Teleport to="body">
        <Transition name="agent-image-lightbox-fade">
            <div v-if="visible" class="agent-image-lightbox" role="dialog" aria-modal="true" :aria-label="alt || '图片预览'" @click="close">
                <button type="button" class="agent-image-lightbox-close" title="关闭" aria-label="关闭" @click.stop="close">
                    <Icon icon="mdi:close" />
                </button>
                <img :src="src" :alt="alt" />
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped lang="scss">
.agent-image-lightbox {
    position: fixed;
    inset: 0;
    z-index: 4000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 36px;
    box-sizing: border-box;
    cursor: zoom-out;

    img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 10px;
        pointer-events: none;
    }
}

.agent-image-lightbox-close {
    position: absolute;
    top: 14px;
    right: 14px;
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font-size: 20px;
}

.agent-image-lightbox-fade-enter-active,
.agent-image-lightbox-fade-leave-active {
    transition: opacity 150ms ease;
}

.agent-image-lightbox-fade-enter-from,
.agent-image-lightbox-fade-leave-to {
    opacity: 0;
}
</style>
