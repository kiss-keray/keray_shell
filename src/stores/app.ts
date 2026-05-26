import { defineStore } from "pinia";
import { emitTo, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WEBVIEW_INIT_DATA_EVENT, type AppType } from "@/utils/window";
import { type } from "@tauri-apps/plugin-os";
import { homeDir, join, tempDir } from "@tauri-apps/api/path";

export const APP_START_OK_EVENT = "app_start_ok";
export type AppStartOkPayload = {
    label: string;
};

export const useAppStore = defineStore("app", () => {
    const closeFuns: UnlistenFn[] = [];
    const appWindow = getCurrentWindow();
    const params = new URLSearchParams(location.search);
    const loadingText = ref("");
    const isFullScreenWindow = ref(false);
    const safeLeft = ref(0);
    const safeTop = ref(0);
    const scaleFactor = ref(1);
    appWindow
        .listen(TauriEvent.WINDOW_RESIZED, async () => {
            if (await appWindow.isFullscreen()) {
                isFullScreenWindow.value = true;
            } else {
                isFullScreenWindow.value = false;
            }
        })
        .then((unlisten) => {
            closeFuns.push(unlisten);
        });
    const windowInitData = ref<unknown>(null);
    appWindow
        .listen(WEBVIEW_INIT_DATA_EVENT, (e) => {
            windowInitData.value = e.payload as unknown;
        })
        .then((unlisten) => {
            closeFuns.push(unlisten);
        });
    // 向所有窗口通知拖动开始的事件
    emitTo<AppStartOkPayload>({ kind: "Any" }, APP_START_OK_EVENT, {
        label: appWindow.label,
    });

    onBeforeMount(async () => {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const size = monitor.size;
        const workArea = monitor.workArea.size;
        scaleFactor.value = monitor.scaleFactor;
        safeLeft.value = (size.width - workArea.width) / monitor.scaleFactor;
        safeTop.value = (size.height - workArea.height) / monitor.scaleFactor;
    });

    onUnmounted(() => {
        closeFuns.forEach((unlisten) => unlisten());
    });

    return {
        appType: (params.get("tp") as AppType) || "main",
        homeDir: homeDir(),
        osType: type(), // 操作系统类型
        label: appWindow.label,
        safeLeft, // 屏幕左侧不可用距离 比如mac的程序菜单栏
        safeTop, // 屏幕顶部不可用距离 比如mac的状态栏
        scaleFactor, // 屏幕缩放因子
        isFullScreenWindow, // 是否全屏
        loadingText, // 全局loading文本
        showOverviewPanel: ref(true), // 是否显示概览面板
        showTermPanel: ref(true), // 是否显示终端面板
        showSftpPanel: ref(true), // 是否显示SFTP面板
        windowInitData, // 窗口初始化数据
    };
});
