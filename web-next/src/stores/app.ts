import { create } from "zustand";
import { emitTo, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
import { type as osType } from "@tauri-apps/plugin-os";
import { WEBVIEW_INIT_DATA_EVENT, type AppType, mainLabels } from "@/utils/window";

export const APP_START_OK_EVENT = "app_start_ok";
export type AppStartOkPayload = {
    label: string;
};

type AppState = {
    appType: AppType;
    homeDir: Promise<string>;
    osType: ReturnType<typeof osType> | "";
    label: string;
    mainLabel: string | null;
    isMainWin: boolean;
    safeLeft: number;
    safeTop: number;
    scaleFactor: number;
    isFullScreenWindow: boolean;
    loadingText: string;
    showOverviewPanel: boolean;
    showTermPanel: boolean;
    showSftpPanel: boolean;
    windowInitData: unknown;
    setLoadingText: (loadingText: string) => void;
    setShowOverviewPanel: (showOverviewPanel: boolean) => void;
    setShowTermPanel: (showTermPanel: boolean) => void;
    setShowSftpPanel: (showSftpPanel: boolean) => void;
    setWindowInitData: (windowInitData: unknown) => void;
};

async function getMainWinLabel() {
    const labels = await mainLabels();
    return (
        labels.sort((v, v1) => {
            const timeA = parseInt(v.split("-")[1] || "0");
            const timeB = parseInt(v1.split("-")[1] || "0");
            return timeA - timeB;
        })[0] || "main"
    );
}

export const useAppStore = create<AppState>((set) => ({
    appType: "main",
    homeDir: Promise.resolve(""),
    osType: "",
    label: "main",
    mainLabel: "main",
    isMainWin: true,
    safeLeft: 0,
    safeTop: 0,
    scaleFactor: 1,
    isFullScreenWindow: false,
    loadingText: "",
    showOverviewPanel: true,
    showTermPanel: true,
    showSftpPanel: true,
    windowInitData: null,
    setLoadingText: (loadingText) => set({ loadingText }),
    setShowOverviewPanel: (showOverviewPanel) => set({ showOverviewPanel }),
    setShowTermPanel: (showTermPanel) => set({ showTermPanel }),
    setShowSftpPanel: (showSftpPanel) => set({ showSftpPanel }),
    setWindowInitData: (windowInitData) => set({ windowInitData }),
}));

let appStoreInited = false;
let closeFuns: UnlistenFn[] = [];

/** 全局窗口监听只能在客户端初始化一次，避免 React StrictMode 重复注册 Tauri 事件。 */
export async function initAppStore(): Promise<void> {
    if (appStoreInited || typeof window === "undefined") return;
    appStoreInited = true;
    const appWindow = getCurrentWindow();
    const params = new URLSearchParams(window.location.search);
    const updateMainLabel = async () => {
        const mainLabel = await getMainWinLabel();
        useAppStore.setState({
            mainLabel,
            isMainWin: mainLabel === appWindow.label,
        });
    };

    useAppStore.setState({
        appType: (params.get("tp") as AppType) || "main",
        homeDir: homeDir(),
        osType: osType(),
        label: appWindow.label,
    });

    closeFuns.push(
        await appWindow.listen(TauriEvent.WINDOW_RESIZED, async () => {
            useAppStore.setState({ isFullScreenWindow: await appWindow.isFullscreen() });
        }),
    );
    closeFuns.push(
        await appWindow.listen(WEBVIEW_INIT_DATA_EVENT, (e) => {
            useAppStore.setState({ windowInitData: e.payload });
        }),
    );
    closeFuns.push(await appWindow.listen<{ label: string }>("tauri://window-created", updateMainLabel));
    closeFuns.push(
        await appWindow.listen<string>("tauri://window-destroyed", async () => {
            if ((await mainLabels()).length === 0) {
                await appWindow.destroy();
            }
            await updateMainLabel();
        }),
    );

    await emitTo<AppStartOkPayload>({ kind: "Any" }, APP_START_OK_EVENT, {
        label: appWindow.label,
    });

    const monitor = await currentMonitor();
    if (monitor) {
        const size = monitor.size;
        const workArea = monitor.workArea.size;
        useAppStore.setState({
            scaleFactor: monitor.scaleFactor,
            safeLeft: (size.width - workArea.width) / monitor.scaleFactor,
            safeTop: (size.height - workArea.height) / monitor.scaleFactor,
        });
    }
    await updateMainLabel();
}

export function disposeAppStoreListeners(): void {
    closeFuns.forEach((unlisten) => unlisten());
    closeFuns = [];
    appStoreInited = false;
}
