import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { UiPreferencesSavedEventKey } from "@/utils/constant";
import { applyUiFontSize } from "@/utils/fontSize";
import { linuxPathToLocalPath } from "@/utils/localFsUtils";
import { useAppStore } from "@/stores/app";
import { useLocalStore } from "@/stores/localstore";

const CONFIG_CACHE_FILE = "config.json";

export type Theme = "nt" | "glass";
export type ThemeMode = "dark" | "light";
export type ServerSyncType = "localFile" | "http" | "remoteFile";

export type ServerRemoteData = {
    ip: string;
    port: number;
    user: string;
    password: string;
    path: string; // 远程目录
};

export type ConfigModel = {
    theme: Theme; // 主题
    themeMode: ThemeMode; // 主题模式
    fontSize: number; // 字体大小
    downloadDir: string; // 下载存放的本地目录
    compactMode: boolean; // 紧凑模式
    overviewWidthPx: number; // 概览面板宽度
    sftpPanelHeightPx: number; // SFTP面板高度
    sftpTreeWidthPx: number; // SFTP面板树宽度
    termFontSize: number; // 终端字体大小
    termLineHeight: number; // 终端行高
    termFontFamily: string; // 终端字体
    termScrollback: number; // 终端滚动回退
    serverSyncKey: string; // 服务器同步key
    serverSyncType: ServerSyncType; // 服务器同步类型 本地文件、http、远程文件
    serverSyncData: string | ServerRemoteData; // 服务器同步数据
    autoServerSync: boolean; // 自动服务器同步(自动上传、自动下载)
};

export const initialState: ConfigModel = {
    theme: "nt",
    themeMode: "dark",
    fontSize: 12,
    downloadDir: "",
    compactMode: false,
    overviewWidthPx: 320,
    sftpPanelHeightPx: 320,
    sftpTreeWidthPx: 250,
    termFontSize: 12,
    termLineHeight: 1.2,
    termFontFamily: "",
    termScrollback: 5000,
    serverSyncKey: "123456",
    serverSyncType: "localFile",
    serverSyncData: "",
    autoServerSync: true,
};

export function normalizeDownloadDir(dir: string): string {
    const t = dir.trim().replace(/\\/g, "/");
    if (!t) return t;
    return t.endsWith("/") ? t : `${t}/`;
}

type ConfigState = ConfigModel & {
    loadFalg: boolean;
    changeConfig: (val: Partial<ConfigModel>) => void;
    loadConfigByDisk: () => Promise<void>;
};

function pickConfigModel(state: ConfigModel): ConfigModel {
    // Vue 版只持久化 reactive ConfigModel；Zustand state 额外包含运行时字段，写缓存前必须剥离。
    return {
        theme: state.theme,
        themeMode: state.themeMode,
        fontSize: state.fontSize,
        downloadDir: state.downloadDir,
        compactMode: state.compactMode,
        overviewWidthPx: state.overviewWidthPx,
        sftpPanelHeightPx: state.sftpPanelHeightPx,
        sftpTreeWidthPx: state.sftpTreeWidthPx,
        termFontSize: state.termFontSize,
        termLineHeight: state.termLineHeight,
        termFontFamily: state.termFontFamily,
        termScrollback: state.termScrollback,
        serverSyncKey: state.serverSyncKey,
        serverSyncType: state.serverSyncType,
        serverSyncData: state.serverSyncData,
        autoServerSync: state.autoServerSync,
    };
}

export const useConfigStore = create<ConfigState>((set) => ({
    ...initialState,
    loadFalg: false,
    changeConfig(val) {
        emit(UiPreferencesSavedEventKey, val);
    },
    async loadConfigByDisk() {
        try {
            const homeDirPath = await useAppStore.getState().homeDir;
            const configData = await useLocalStore.getState().readCache<ConfigModel>("CONFIG", CONFIG_CACHE_FILE);
            const defaultDownloadDir = `${homeDirPath}/Downloads/keray_shell`;
            const serverSyncData = linuxPathToLocalPath(`${homeDirPath}/Downloads/keray_shell_server`);
            const next: ConfigModel = {
                ...initialState,
                ...configData,
                serverSyncData: configData?.serverSyncData ?? serverSyncData,
                downloadDir: linuxPathToLocalPath(normalizeDownloadDir(configData?.downloadDir || defaultDownloadDir)),
            };
            set({ ...next, loadFalg: true });
            applyUiFontSize(next.fontSize);
        } catch (err) {
            console.error("readCache error:", err);
            set({ loadFalg: true });
        }
    },
}));

let configStoreInited = false;
let configUnlisten: UnlistenFn | null = null;

/** 配置监听跨窗口共享，必须显式初始化并只注册一次。 */
export async function initConfigStore(): Promise<void> {
    if (configStoreInited || typeof window === "undefined") return;
    configStoreInited = true;
    await useConfigStore.getState().loadConfigByDisk();
    configUnlisten = await listen<Partial<ConfigModel>>(UiPreferencesSavedEventKey, async ({ payload }) => {
        const next = pickConfigModel({
            ...useConfigStore.getState(),
            ...payload,
        });
        useConfigStore.setState(next);
        applyUiFontSize(next.fontSize);
        if (useAppStore.getState().mainLabel === getCurrentWindow().label) {
            await useLocalStore.getState().writeCache("CONFIG", next, CONFIG_CACHE_FILE);
        }
    });
}

export function disposeConfigStoreListeners(): void {
    configUnlisten?.();
    configUnlisten = null;
    configStoreInited = false;
}
