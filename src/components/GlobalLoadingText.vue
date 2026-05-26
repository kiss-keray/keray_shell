<script setup lang="ts">
import { storeToRefs } from "pinia";
const appStore = useAppStore();
const { loadingText } = storeToRefs(appStore);
</script>

<template>
    <Teleport to="body">
        <div v-if="loadingText" class="loading-mask">
            <div class="loading-content">
                <div class="loading-icon-wrap">
                    <Icon icon="mdi:loading" class="loading-icon" />
                </div>
                <div class="loading-text-wrap">
                    <p class="loading-text">{{ loadingText }}</p>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped lang="scss">
.loading-mask {
    position: fixed;
    inset: 0;
    z-index: 2100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(7, 10, 16, 0.48);
    backdrop-filter: blur(2px);
}

.loading-content {
    min-width: 240px;
    max-width: min(520px, calc(100vw - 40px));
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: #1f2430;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}

.loading-icon-wrap {
    width: 30px;
    height: 30px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(110, 179, 255, 0.14);
    flex-shrink: 0;
}

.loading-icon {
    width: 18px;
    height: 18px;
    color: #8fc2ff;
    animation: app-loading-spin 0.9s linear infinite;
}

.loading-text-wrap {
    min-width: 0;
}

.loading-title {
    margin: 0;
    color: rgba(219, 228, 243, 0.72);
}

.loading-text {
    margin: 2px 0 0;
    font-size: var(--font-size-md);
    color: #edf3ff;
    line-height: 1.35;
    word-break: break-word;
}

@keyframes app-loading-spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
