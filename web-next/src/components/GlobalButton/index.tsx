"use client";

import Icon from "@/components/Icon";
import { useAppStore } from "@/stores/app";
import { useConfigStore } from "@/stores/config";
import { openOrFocusServerTreeWindow, openOrFocusSettingsWindow } from "@/utils/window";
import type { SettingsTab } from "@/types/settings";
import "./index.scss";

type Bts = "serverTree" | "setting" | "theme" | "themeMode" | "overviewPanel" | "termPanel" | "sftpPanel";

export type GlobalButtonProps = {
    bts?: Bts[];
    settingTab?: SettingsTab;
};

export default function GlobalButton({
    bts = ["serverTree", "setting", "theme", "themeMode", "overviewPanel", "termPanel", "sftpPanel"],
    settingTab = "general",
}: GlobalButtonProps) {
    const theme = useConfigStore((state) => state.theme);
    const themeMode = useConfigStore((state) => state.themeMode);
    const changeConfig = useConfigStore((state) => state.changeConfig);
    const osType = useAppStore((state) => state.osType);
    const showOverviewPanel = useAppStore((state) => state.showOverviewPanel);
    const showTermPanel = useAppStore((state) => state.showTermPanel);
    const showSftpPanel = useAppStore((state) => state.showSftpPanel);
    const setShowOverviewPanel = useAppStore((state) => state.setShowOverviewPanel);
    const setShowTermPanel = useAppStore((state) => state.setShowTermPanel);
    const setShowSftpPanel = useAppStore((state) => state.setShowSftpPanel);
    const isNtTheme = theme === "nt";
    const isDarkMode = themeMode === "dark";

    return (
        <div className="GlobalButton global-button flex items-center">
            {bts.includes("serverTree") ? (
                <button type="button" className="btn" title="服务器列表" onClick={() => void openOrFocusServerTreeWindow()}>
                    <Icon icon="material-symbols:folder" className="text-lg" />
                </button>
            ) : null}
            {/* macOS 下支持原生毛玻璃，其他系统不支持 */}
            {bts.includes("theme") && osType === "macos" ? (
                <button
                    type="button"
                    className={`btn${!isNtTheme ? " active" : ""}`}
                    title="切换主题（拟态/毛玻璃）"
                    onClick={() => changeConfig({ theme: isNtTheme ? "glass" : "nt" })}
                >
                    <Icon icon={isNtTheme ? "mdi:water-outline" : "mdi:water"} className="text-lg" />
                </button>
            ) : null}
            {bts.includes("themeMode") ? (
                <button type="button" className={`btn${!isDarkMode ? " active" : ""}`} title="切换明暗模式" onClick={() => changeConfig({ themeMode: isDarkMode ? "light" : "dark" })}>
                    <Icon icon={isDarkMode ? "mdi:weather-night" : "mdi:white-balance-sunny"} className="text-lg" />
                </button>
            ) : null}
            {bts.includes("overviewPanel") ? (
                <button type="button" className={`btn${showOverviewPanel ? " active" : ""}`} title="显示/隐藏概览面板" onClick={() => setShowOverviewPanel(!showOverviewPanel)}>
                    <Icon icon={showOverviewPanel ? "mdi:view-dashboard" : "mdi:view-dashboard-outline"} className="text-lg" />
                </button>
            ) : null}
            {bts.includes("termPanel") ? (
                <button type="button" className={`btn${showTermPanel ? " active" : ""}`} title="显示/隐藏终端面板" onClick={() => setShowTermPanel(!showTermPanel)}>
                    <Icon icon={showTermPanel ? "mdi:console" : "mdi:console-line"} className="text-lg" />
                </button>
            ) : null}
            {bts.includes("sftpPanel") ? (
                <button type="button" className={`btn${showSftpPanel ? " active" : ""}`} title="显示/隐藏SFTP面板" onClick={() => setShowSftpPanel(!showSftpPanel)}>
                    <Icon icon={showSftpPanel ? "mdi:folder-network" : "mdi:folder-network-outline"} className="text-lg" />
                </button>
            ) : null}
            {bts.includes("setting") ? (
                <button type="button" className="btn" title="设置" onClick={() => void openOrFocusSettingsWindow(settingTab)}>
                    <Icon icon="mdi:cog" className="text-lg" />
                </button>
            ) : null}
        </div>
    );
}
