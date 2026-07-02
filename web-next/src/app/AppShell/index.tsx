"use client";

import dynamic from "next/dynamic";
import { TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import DefaultMenus from "@/components/DefaultMenus";
import GlobalLoadingText from "@/components/GlobalLoadingText";
import ImperativeUIHost from "@/components/ImperativeUIHost";
import WindowTitleBar from "@/components/WindowTitleBar";
import { initAppStore, disposeAppStoreListeners, useAppStore } from "@/stores/app";
import { initChannelInstancesStore, disposeChannelInstancesStoreListeners } from "@/stores/channelInstances";
import { initConfigStore, disposeConfigStoreListeners, useConfigStore, type Theme, type ThemeMode } from "@/stores/config";
import { useKeyEventStore } from "@/stores/keyEvent";
import { initLocalStore } from "@/stores/localstore";
import { useReactBodyEventStore } from "@/stores/reactBodyEvent";
import { initServerDataStore, disposeServerDataStoreListeners } from "@/stores/serverData";
import { CustomMenusEventKey } from "@/utils/constant";
import { showConfirm } from "@/utils/ui";
import { mainLabels, type AppType } from "@/utils/window";
import { syncWindowGlass, syncWindowTransparent } from "@/utils/windowGlass";
import type { MenuItem } from "@/components/DefaultMenuItems";
import "./index.scss";

const LoadingFallback = () => <div className="window-chunk-loading" aria-busy="true" />;

/** 按窗口类型分包，子窗口只加载对应 chunk。 */
const SettingWin = dynamic(() => import("@/components/window/SettingWin"), { ssr: false, loading: LoadingFallback });
const ServerTreeWin = dynamic(() => import("@/components/window/ServerTreeWin"), { ssr: false, loading: LoadingFallback });
const EditServerWin = dynamic(() => import("@/components/window/EditServerWin"), { ssr: false, loading: LoadingFallback });
const MonacoWin = dynamic(() => import("@/components/window/MonacoWin"), { ssr: false, loading: LoadingFallback });
const UploadConflictWin = dynamic(() => import("@/components/window/UploadConflictWin"), { ssr: false, loading: LoadingFallback });
const MainWin = dynamic(() => import("@/components/window/MainWin"), { ssr: false, loading: LoadingFallback });

type MenuState = {
    show: boolean;
    menus: MenuItem[] | null;
    pos: { x: number; y: number };
};

function readAppTypeFromLocation(): AppType {
    if (typeof window === "undefined") return "main";
    return (new URLSearchParams(window.location.search).get("tp") as AppType) || "main";
}

export default function AppShell() {
    const [appType, setAppType] = useState<AppType>(() => readAppTypeFromLocation());
    const [appReady, setAppReady] = useState(false);
    const [menuData, setMenuData] = useState<MenuState>({ show: false, menus: null, pos: { x: 0, y: 0 } });
    const appStoreType = useAppStore((state) => state.appType);
    const osType = useAppStore((state) => state.osType);
    const theme = useConfigStore((state) => state.theme);
    const themeMode = useConfigStore((state) => state.themeMode);
    const compactMode = useConfigStore((state) => state.compactMode);
    const registerKeyEvent = useKeyEventStore((state) => state.register);
    const registerBodyEvent = useReactBodyEventStore((state) => state.register);

    const activeAppType = appStoreType === "main" && appType !== "main" ? appType : appStoreType || appType;

    function showMenus({ menus, target }: { menus: MenuItem[] | null; target: React.MouseEvent | null }) {
        setMenuData({
            show: Boolean(menus),
            menus,
            pos: menus && target ? { x: target.clientX, y: target.clientY } : { x: 0, y: 0 },
        });
    }

    useEffect(() => {
        let disposed = false;
        setAppType(readAppTypeFromLocation());
        // Store 初始化顺序保留 Vue 版依赖关系：先窗口/路径，再读配置和服务器数据，最后注册业务事件。
        void (async () => {
            try {
                await initAppStore();
                await initLocalStore();
                await initConfigStore();
                await initServerDataStore();
                await initChannelInstancesStore();
            } catch (err) {
                console.error("初始化应用状态失败", err);
            } finally {
                // 业务窗口挂载后会立刻消费初始化 payload；必须等服务器数据真实加载完，避免编辑器误判 server 不存在。
                if (!disposed) setAppReady(true);
            }
        })();

        return () => {
            disposed = true;
            disposeChannelInstancesStoreListeners();
            disposeServerDataStoreListeners();
            disposeConfigStoreListeners();
            disposeAppStoreListeners();
        };
    }, []);

    // 注册事件：右键菜单、鼠标按下、Esc 键
    useEffect(() => {
        /** 自定义右键菜单事件 */
        const onCustomMenus = (event: Event) => {
            const detail = (event as CustomEvent<{ menus: MenuItem[] | null; target: React.MouseEvent }>).detail;
            if (!detail) return;
            showMenus(detail);
        };

        document.body.addEventListener(CustomMenusEventKey, onCustomMenus);

        /** 生产环境禁用右键菜单 */
        const unregisterContextMenu =
            process.env.NODE_ENV !== "development"
                ? registerBodyEvent("contextmenu", (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      return true;
                  })
                : () => {};
        return () => {
            document.body.removeEventListener(CustomMenusEventKey, onCustomMenus);
            unregisterContextMenu();
        };
    }, [registerBodyEvent, registerKeyEvent]);

    // 注册事件：右键菜单、鼠标按下、Esc 键
    useEffect(() => {
        /** 鼠标不是右键且菜单已显示时，隐藏右键菜单 */
        const unregisterMouseDown = registerBodyEvent("mousedown", (event) => {
            if (event.button !== 2 && menuData.show) {
                showMenus({ menus: null, target: event });
                return true;
            }
            return false;
        });
        /** Esc 键关闭菜单 */
        const unregisterEsc = registerKeyEvent((event) => {
            if (event.key === "Escape" && menuData.show) {
                showMenus({ menus: null, target: null });
                return true;
            }
            return false;
        });

        return () => {
            unregisterMouseDown();
            unregisterEsc();
        };
    }, [registerBodyEvent, registerKeyEvent, menuData.show]);

    useEffect(() => {
        const html = document.documentElement;
        html.classList.add("theme");
        const themes: Theme[] = ["nt", "glass"];
        const modes: ThemeMode[] = ["dark", "light"];
        themes.forEach((item) => html.classList.toggle(item, item === theme));
        modes.forEach((item) => html.classList.toggle(item, item === themeMode));
        html.classList.toggle("ui-compact", compactMode);
        if (osType) {
            html.classList.remove("macos", "windows", "linux");
            html.classList.add(osType);
        }
        void syncWindowTransparent(theme === "glass", themeMode === "dark");
        void syncWindowGlass(theme, themeMode);
    }, [theme, themeMode, compactMode, osType]);

    useEffect(() => {
        if (activeAppType === "monaco-editor") return;
        let disposed = false;
        let unlisten: (() => void) | null = null;
        const win = getCurrentWindow();
        void win
            .listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
                const labels = await mainLabels();
                if (labels.length === 1 && labels[0] === win.label) {
                    await win.setFocus();
                    const ok = await showConfirm({
                        title: "确定关闭",
                        message: "确定关闭吗？",
                        danger: true,
                    });
                    if (ok) await win.destroy();
                } else {
                    await win.destroy();
                }
            })
            .then((fn) => {
                if (disposed) fn();
                else unlisten = fn;
            });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [activeAppType]);

    const content = useMemo(() => {
        if (!appReady) return <LoadingFallback />;
        if (activeAppType === "settings") return <SettingWin />;
        if (activeAppType === "server-tree") return <ServerTreeWin />;
        if (activeAppType === "edit-server") return <EditServerWin />;
        if (activeAppType === "monaco-editor") return <MonacoWin />;
        if (activeAppType === "upload-conflict") return <UploadConflictWin />;
        return <MainWin />;
    }, [activeAppType, appReady]);

    return (
        <div className="AppShell">
            {osType !== "macos" ? <WindowTitleBar /> : null}
            <div data-tauri-drag-region="" className="drag-region" />
            {menuData.show ? <DefaultMenus menus={menuData.menus || []} pos={menuData.pos} onClose={() => setMenuData((prev) => ({ ...prev, show: false }))} /> : null}
            {content}
            <GlobalLoadingText />
            <ImperativeUIHost />
        </div>
    );
}
