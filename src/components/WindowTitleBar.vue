<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";

defineOptions({
    name: "WindowTitleBar",
});

const win = getCurrentWindow();

async function onClose() {
    await win.close();
}

async function onMinimize() {
    await win.minimize();
}

async function onToggleMaximize() {
    await win.toggleMaximize();
}

function onTitleMouseDown(e: MouseEvent) {
    if (e.button !== 0 || e.detail !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    void win.toggleMaximize();
}
</script>

<template>
    <div class="window-title-bar">
        <div class="traffic-lights">
            <button type="button" class="traffic close" title="关闭" aria-label="关闭" @click="onClose" />
            <button type="button" class="traffic minimize" title="最小化" aria-label="最小化" @click="onMinimize" />
            <button type="button" class="traffic maximize" title="最大化" aria-label="最大化" @click="onToggleMaximize" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.window-title-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 30px;
    z-index: 99999999;
    display: flex;
    align-items: center;
    user-select: none;
    pointer-events: none;
}

.traffic-lights {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    flex-shrink: 0;
    pointer-events: auto;
}

.traffic {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 0.5px solid rgba(0, 0, 0, 0.12);
    padding: 0;
    cursor: default;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: filter 0.15s ease;

    &::before {
        content: "";
        position: absolute;
        opacity: 0;
        transition: opacity 0.15s ease;
        color: rgba(0, 0, 0, 0.55);
        font-size: 9px;
        font-weight: 700;
        line-height: 1;
    }

    &.close {
        background: #ff5f57;

        &::before {
            content: "×";
            font-size: 11px;
            margin-top: -1px;
        }
    }

    &.minimize {
        background: #febc2e;

        &::before {
            content: "−";
        }
    }

    &.maximize {
        background: #28c840;

        &::before {
            content: "+";
            font-size: 10px;
        }
    }

    &:hover {
        filter: brightness(0.95);

        &::before {
            opacity: 1;
        }
    }

    &:active {
        filter: brightness(0.88);
    }
}

.title-bar-drag {
    flex: 1;
    height: 100%;
    min-width: 0;
    pointer-events: auto;
}
</style>
