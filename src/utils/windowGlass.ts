import { invoke } from "@tauri-apps/api/core";
import { type } from "@tauri-apps/plugin-os";
import type { Theme, ThemeMode } from "@/stores/config";

/** macOS / Windows 支持原生窗口虚化 */
export function supportsNativeWindowGlass(): boolean {
    const os = type();
    return os === "macos" || os === "windows";
}

/** 运行时切换窗口原生透明（macOS NSWindow / Windows DWM） */
export async function syncWindowTransparent(transparent: boolean, dark: boolean): Promise<void> {
    if (!supportsNativeWindowGlass()) return;
    const rgba = { r: 0, g: 0, b: 0, a: 0 };
    if (!transparent) {
        if (dark) {
            // --nt-surface: #3a3b3b;
            rgba.r = 18;
            rgba.g = 18;
            rgba.b = 18;
            rgba.a = 255;
        } else {
            //  --nt-surface: #e6e8ec;
            rgba.r = 243;
            rgba.g = 243;
            rgba.b = 243;
            rgba.a = 255;
        }
    }
    try {
        await invoke("sync_window_transparent", rgba);
    } catch (e) {
        console.warn("sync_window_transparent failed", e);
    }
}

/** 同步当前窗口原生虚化（玻璃主题 + dark/light 模式） */
export async function syncWindowGlass(theme: Theme, themeMode: ThemeMode): Promise<void> {
    const useNative = theme === "glass" && supportsNativeWindowGlass();
    document.documentElement.classList.toggle("native-window-glass", useNative);
    if (!supportsNativeWindowGlass()) return;
    try {
        await invoke("sync_window_glass", {
            enabled: useNative,
            dark: themeMode === "dark",
        });
    } catch (e) {
        console.warn("sync_window_glass failed", e);
        document.documentElement.classList.remove("native-window-glass");
    }
}
