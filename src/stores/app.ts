import { defineStore } from "pinia";
import { emitTo, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WEBVIEW_INIT_DATA_EVENT, type AppType } from "@/utils/window";
import { type } from "@tauri-apps/plugin-os";
import { homeDir } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const APP_START_OK_EVENT = "app_start_ok";
export type AppStartOkPayload = {
    label: string;
};
async function __getMainWinLabel() {
    const labels = await mainLabels();
    const mainLable =
        labels.sort((v, v1) => {
            const timeA = parseInt(v.split("-")[1] || "0");
            const timeB = parseInt(v1.split("-")[1] || "0");
            return timeA - timeB;
        })[0] || "main";
    return mainLable;
}
export const useAppStore = defineStore("app", () => {
    const closeFuns: UnlistenFn[] = [];
    const appWindow = getCurrentWindow();
    const mainLabel = ref<string | null>("main");
    const params = new URLSearchParams(location.search);
    const loadingText = ref("");
    const isFullScreenWindow = ref(false);
    const safeLeft = ref(0);
    const safeTop = ref(0);
    const scaleFactor = ref(1);
    const isMainWin = computed(() => mainLabel.value === appWindow.label);
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
    appWindow
        .listen<{ label: string }>("tauri://window-created", async ({ payload }) => {
            // 获取主窗口 label
            // hild-开头的是子窗口 也可以作为主窗口存在
            mainLabel.value = await __getMainWinLabel();
        })
        .then((unlisten) => {
            closeFuns.push(unlisten);
        });

    appWindow
        .listen<string>("tauri://window-destroyed", async ({ payload }) => {
            if ((await mainLabels()).length === 0) {
                // 没有主窗口了 关闭当前窗口
                appWindow.destroy();
            }
            mainLabel.value = await __getMainWinLabel();
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
    __getMainWinLabel().then((label) => {
        mainLabel.value = label;
    });

    return {
        appType: (params.get("tp") as AppType) || "main",
        homeDir: homeDir(),
        osType: type(), // 操作系统类型
        label: appWindow.label,
        mainLabel, // 主窗口 label
        isMainWin, // 是否是主窗口
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
