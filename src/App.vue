<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { TauriEvent } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { storeToRefs } from "pinia";
import { mainLabels } from "./utils/window";
import { syncWindowGlass, syncWindowTransparent } from "./utils/windowGlass";
import type { MenuItem } from "./components/DefaultMenuItems.vue";

/** 按窗口类型分包，子窗口只加载对应 chunk */
const SettingWin = defineAsyncComponent(() => import("@/components/window/SettingWin.vue"));
const ChildWin = defineAsyncComponent(() => import("@/components/window/ChildWin.vue"));
const ServerTreeWin = defineAsyncComponent(() => import("@/components/window/ServerTreeWin.vue"));
const EditServerWin = defineAsyncComponent(() => import("@/components/window/EditServerWin.vue"));
const MonacoWin = defineAsyncComponent(() => import("@/components/window/MonacoWin.vue"));
const UploadConflictWin = defineAsyncComponent(() => import("@/components/window/UploadConflictWin.vue"));
const MainWin = defineAsyncComponent(() => import("@/components/window/MainWin.vue"));
const configStore = useConfigStore();
const keyEventStore = useKeyEventStore();
const appStore = useAppStore();
const appType = appStore.appType;
const { theme, themeMode, compactMode, fontSize } = storeToRefs(configStore);
const { safeLeft, safeTop } = storeToRefs(appStore);
const win = getCurrentWindow();
const menuData = reactive({
    show: false,
    menus: [] as MenuItem[] | null,
    pos: {
        x: 0,
        y: 0,
    },
});

function showMenus({ menus, target }: { menus: MenuItem[] | null; target: any }) {
    menuData.show = Boolean(menus);
    if (!menus) return;
    menuData.menus = menus;
    menuData.pos = {
        x: target.clientX,
        y: target.clientY,
    };
}

function globalListen() {
    if (!import.meta.env.DEV) {
        // 生产环境禁用右键菜单
        document.body.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
    }
    document.body.addEventListener(CustomMenusEventKey, (event: any) => {
        showMenus(event.detail);
    });
    document.body.addEventListener("mousedown", (event) => {
        if (event.button !== 2) {
            showMenus({ menus: null, target: event.target });
        }
    });
    keyEventStore.register((event) => {
        if (event.key === "Escape" && menuData.show) {
            menuData.show = false;
            return true;
        }
        return false;
    });
}

watch(theme, (newTheme: Theme, oldTheme: Theme) => {
    if (oldTheme) {
        document.documentElement.classList.remove(oldTheme);
    }
    document.documentElement.classList.add(newTheme);
    void syncWindowTransparent(theme.value === "glass", themeMode.value === "dark");
    void syncWindowGlass(newTheme, themeMode.value);
});
watch(themeMode, (newThemeMode: ThemeMode, oldThemeMode: ThemeMode) => {
    if (oldThemeMode) {
        document.documentElement.classList.remove(oldThemeMode);
    }
    document.documentElement.classList.add(newThemeMode);
    void syncWindowTransparent(theme.value === "glass", themeMode.value === "dark");
    void syncWindowGlass(theme.value, newThemeMode);
});

watch(
    compactMode,
    (v) => {
        document.documentElement.classList.toggle("ui-compact", v);
    },
    { immediate: true },
);

onBeforeMount(async () => {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const size = monitor.size;
    const workArea = monitor.workArea.size;
    safeLeft.value = (size.width - workArea.width) / monitor.scaleFactor;
    safeTop.value = (size.height - workArea.height) / monitor.scaleFactor;
});

onMounted(async () => {
    globalListen();
    // 直接把class添加到html标签
    document.documentElement.classList.add("theme");
    document.documentElement.classList.add(theme.value);
    document.documentElement.classList.add(themeMode.value);
    document.documentElement.classList.add(appStore.osType);
    void syncWindowTransparent(theme.value === "glass", themeMode.value === "dark");
    void syncWindowGlass(theme.value, themeMode.value);
    document.body.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });

    if (appType !== "monaco-editor") {
        win.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
            const mls = await mainLabels();
            if (mls.length === 1 && mls[0] === win.label) {
                // 主窗口了 提示确定关闭
                const ok = await showConfirm({
                    title: "确定关闭",
                    message: "确定关闭吗？",
                    danger: true,
                });
                if (ok) {
                    win.destroy();
                }
            } else {
                win.destroy();
            }
        });
    }
});
</script>

<template>
    <WindowTitleBar v-if="appStore.osType !== 'macos'" />
    <div data-tauri-drag-region="" class="drag-region"></div>
    <DefaultMenus v-if="menuData.show" :menus="menuData.menus || []" :pos="menuData.pos" @close="menuData.show = false" />
    <Suspense>
        <SettingWin v-if="appType === 'settings'" />
        <ChildWin v-else-if="appType === 'child'" />
        <ServerTreeWin v-else-if="appType === 'server-tree'" />
        <EditServerWin v-else-if="appType === 'edit-server'" />
        <MonacoWin v-else-if="appType === 'monaco-editor'" />
        <UploadConflictWin v-else-if="appType === 'upload-conflict'" />
        <MainWin v-else />
        <template #fallback>
            <div class="window-chunk-loading" aria-busy="true" />
        </template>
    </Suspense>
    <GlobalLoadingText />
</template>

<style scoped lang="scss">
.window-chunk-loading {
    flex: 1;
    min-height: 0;
}

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
