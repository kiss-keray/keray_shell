import { invoke as coreInvoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { type } from "@tauri-apps/plugin-os";

/** 调用 Tauri 插件命令 */
export async function invoke<T>(name: string, params?: { [key: string]: any }): Promise<T> {
    const res: { code: number; data: T; msg: string | null } = await coreInvoke(name, params);
    if (res.code !== 200) {
        console.error(`${name} => ${JSON.stringify(res)}`);
        // @ts-ignore
        throw res;
    }
    return res.data;
}

/** 设置元素样式 */
export function settingStyle(moduleDom: HTMLElement, style: { [key: string]: string }) {
    moduleDom.onclick = (e) => {};
    Object.keys(style).forEach((key) => {
        moduleDom.style[key as any] = style[key];
    });
}

/** 复制文本到剪贴板 */
export async function copyText(text: string) {
    try {
        await navigator.clipboard.writeText(text);
        console.log("已复制到剪贴板:", text);
    } catch (err) {
        console.error("复制失败:", err);
    }
}

/** 读取剪切板内容 */
export async function readClipboardText(): Promise<string> {
    try {
        const text = await invoke<string>("read_clipboard_text", {});
        console.log("剪切板内容：", text);
        return text;
    } catch (err) {
        console.error("读取剪切板失败：", err);
    }
    return "";
}

/** 判断事件是否发生在目标元素上 */
export function eventHave(event: Event, target: HTMLElement): boolean {
    let dom = event.target as HTMLElement;
    for (; dom; dom = dom.parentNode as HTMLElement) {
        if (dom === target) {
            return true;
        }
    }
    return false;
}

/** 按数量级动态选用 B / KB / MB / GB / TB（1024 进位） */
export function formatAdaptiveBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ["KB", "MB", "GB", "TB"] as const;
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    const frac = n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return `${n.toFixed(frac)} ${units[i]}`;
}

/** 格式化网速 */
export function formatSpeedBps(bps: number): string {
    if (!Number.isFinite(bps) || bps < 0.1) return "—";
    return `${formatAdaptiveBytes(bps)}its/s`;
}

/** 远端路径在 shell 单引号内安全转义 */
export function shellSingleQuote(path: string): string {
    return `'${path.replace(/'/g, `'\"'\"'`)}'`;
}

/** 执行远端命令 */
export async function execRemote(serverId: string, cmd: string): Promise<string> {
    return invoke<string>("exec_cmd", { serverId, cmd });
}

/** 将 UTF-8 字符串转换为 Base64 字符串 */
export function utf8ToBase64(s: string): string {
    return btoa(unescape(encodeURIComponent(s)));
}

/** 将 Base64 字符串转换为 UTF-8 字符串 */
export function base64ToUtf8(s: string): string {
    return decodeURIComponent(escape(atob(s)));
}

/** tauri缺失dargOver dragLeave drop事件 监听窗口的drag事件dispatch dragover dragleave drop事件 */
export function dragListener(getDoms: () => HTMLElement[]): Promise<UnlistenFn> {
    let time = 0;
    async function onDragOverEvent(payload: DragDropEvent) {
        if (payload.type !== "over") return;
        let { x, y } = payload.position; // x,y时鼠标在body上的x,y坐标
        if (type() === "windows") {
            const scaleFactor = await getCurrentWindowScaleFactor();
            x = x / scaleFactor;
            y = y / scaleFactor;
        }
        const now = Date.now();
        // 100毫秒计算一次坐标 避免频繁计算
        if (now - time < 100) return;
        time = now;
        const doms = getDoms();
        for (let i = 0; i < doms.length; i++) {
            // 获取当前行的x,y,endx,endy
            const rowDom = doms[i];
            const rowRect = rowDom.getBoundingClientRect();
            const rowX = rowRect.left;
            const rowY = rowRect.top;
            const endX = rowX + rowRect.width;
            const endY = rowY + rowRect.height;
            if (rowX < x && x < endX && rowY < y && y < endY) {
                // @ts-ignore
                rowDom._isDragPreviewTarget = true;
                rowDom.dispatchEvent(
                    new DragEvent("dragover", {
                        bubbles: true,
                        cancelable: true,
                        clientX: x,
                        clientY: y,
                        relatedTarget: rowDom,
                    }),
                );
            }
            // @ts-ignore
            else if (rowDom._isDragPreviewTarget) {
                // @ts-ignore
                rowDom._isDragPreviewTarget = false;
                rowDom.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, clientX: x, clientY: y, relatedTarget: rowDom }));
            }
        }
    }

    function onDragDropEvent(payload: DragDropEvent) {
        if (payload.type !== "drop") return;
        const { x, y } = payload.position; // x,y时鼠标在body上的x,y坐标
        const doms = getDoms();
        for (let i = 0; i < doms.length; i++) {
            const rowDom = doms[i];
            // @ts-ignore
            if (rowDom._isDragPreviewTarget) {
                rowDom.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, relatedTarget: rowDom }));
            }
        }
    }
    // 将窗口拖回来
    return getCurrentWindow().onDragDropEvent(({ payload }) => {
        if (payload.type === "over") {
            onDragOverEvent(payload);
        } else if (payload.type === "drop") {
            onDragDropEvent(payload);
        }
    });
}

export async function getCurrentWindowScaleFactor(): Promise<number> {
    const monitor = await currentMonitor();
    if (!monitor) return 1;
    return monitor.scaleFactor;
}
