import { getMainWinLabel } from "@/utils/window";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defineStore } from "pinia";

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

function normalizeDownloadDir(dir: string): string {
    const t = dir.trim().replace(/\\/g, "/");
    if (!t) return t;
    return t.endsWith("/") ? t : `${t}/`;
}

export const useConfigStore = defineStore("config", () => {
    const localStore = useLocalStore();
    const appStore = useAppStore();
    const { appType, homeDir, osType } = appStore;
    const data = reactive<ConfigModel>(initialState);
    const dataRef = toRefs(data);
    const loadFalg = ref(false);
    // 获取用户根目录
    function loadConfigByDisk() {
        Promise.all([homeDir, localStore.readCache<ConfigModel>("CONFIG", CONFIG_CACHE_FILE)])
            .then(([homeDirPath, configData]) => {
                const defaultDownloadDir = `${homeDirPath}/Downloads/keray_shell`;
                initialState.serverSyncData = linuxPathToLocalPath(`${homeDirPath}/Downloads/keray_shell_server`);
                Object.assign(data, {
                    ...initialState,
                    ...configData,
                    downloadDir: linuxPathToLocalPath(normalizeDownloadDir(configData?.downloadDir || defaultDownloadDir)),
                });
                applyUiFontSize(data.fontSize);
            })
            .catch((err) => {
                console.error("readCache error:", err);
            })
            .finally(() => {
                loadFalg.value = true;
            });
    }
    loadConfigByDisk();

    function changeConfig(val: Partial<ConfigModel>) {
        emit(UiPreferencesSavedEventKey, val);
    }

    // main窗口监听设置窗口保存事件
    listen<ConfigModel>(UiPreferencesSavedEventKey, async ({ payload }) => {
        Object.assign(data, {
            ...data,
            ...payload,
        });
        applyUiFontSize(data.fontSize);
        const mainLabel = getMainWinLabel();
        // main窗口保存配置
        if (mainLabel === getCurrentWindow().label) {
            localStore.writeCache("CONFIG", data, CONFIG_CACHE_FILE);
        }
    });

    return {
        ...dataRef,
        changeConfig,
        loadFalg,
    };
});
