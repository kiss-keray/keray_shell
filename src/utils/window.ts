import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SettingsTab } from "@/components/SettingDialog.vue";
import type { WebviewOptions } from "@tauri-apps/api/webview";
import { getCurrentWindow, type WindowOptions } from "@tauri-apps/api/window";
import { emitTo, listen, once, type UnlistenFn } from "@tauri-apps/api/event";
import { type } from "@tauri-apps/plugin-os";
import { APP_START_OK_EVENT, type AppStartOkPayload } from "@/stores/app";
import type { DragStartPayload } from "@/components/ssh/ShellInstance.vue";

export type AppType = "main" | "child" | "settings" | "server-tree" | "edit-server" | "monaco-editor" | "upload-conflict";

/** 窗口初始化数据事件 */
export const WEBVIEW_INIT_DATA_EVENT = "tauri://webview-init-data";

/** 打开或聚焦独立「设置」窗口 */
export async function openOrFocusSettingsWindow(tab: SettingsTab = "general"): Promise<void> {
    const label = `settings`;
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
    }
    await createNewWindow(
        label,
        "settings",
        `&tab=${tab}`,
        {
            width: 760,
            height: 620,
        },
        {},
    );
}

/** 打开或聚焦独立「服务器列表」窗口 */
export async function openOrFocusServerTreeWindow(): Promise<void> {
    const label = `server-tree`;
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
    }
    await createNewWindow(
        label,
        "server-tree",
        `&from=${getCurrentWindow().label}`,
        {
            width: 1000,
            height: 600,
        },
        {},
    );
}

/** 打开编辑服务器窗口 payload */
export type EditServerWindowPayload = {
    mode: "create" | "edit"; // 新建或编辑服务器
    from: string; // 打开编辑窗口的来源窗口，保存后只通知这个窗口即可
    groupId?: string; // 新建时的默认分组，编辑时作为兜底分组
    serverId?: string; // 编辑模式下的服务器 ID
};

/** 编辑服务器窗口保存事件 */
export const EDIT_SERVER_SAVED_EVENT = "edit-server-saved";

/** 编辑服务器窗口保存事件 payload */
export type EditServerSavedPayload = {
    sourceLabel: string; // 保存数据的 edit-server 窗口
    editId: string; // 编辑的ID
    connect: boolean; // 是否连接
};

/** 打开或复用独立「服务器编辑」窗口；窗口 label 固定为 edit-server。 */
export async function openOrFocusEditServerWindow(payload: Omit<EditServerWindowPayload, "from">): Promise<void> {
    const label = "edit-server";
    const data: EditServerWindowPayload = {
        ...payload,
        from: getCurrentWindow().label,
    };
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
        emitTo({ kind: "Window", label }, WEBVIEW_INIT_DATA_EVENT, data).catch((e) => {
            console.error("send WEBVIEW_INIT_DATA_EVENT error", e);
        });
        await existing.show();
        await existing.setFocus();
        return;
    }
    await createNewWindow(
        label,
        "edit-server",
        "",
        {
            width: 720,
            height: 680,
            minWidth: 620,
            minHeight: 560,
        },
        data,
    );
}

/** 打开 Monaco 编辑器窗口 payload */
export type MonacoEditorWindowPayload = {
    sessionId: string; // 会话 ID
    serverId: string; // 服务器 ID
    path: string; // 文件路径
    linkPath: string | null; // 如果是符号链接，则为目标路径
    from: string; // 打开编辑窗口的来源窗口，保存后只通知这个窗口即可
};

/** Monaco 编辑器窗口保存事件 */
export const MONACO_EDITOR_SAVED_EVENT = "monaco-editor-saved";

/** Monaco 编辑器窗口保存事件 payload */
export type MonacoEditorSavedPayload = {
    sessionId: string; // 会话 ID
    path: string; // 文件路径
};

/** Monaco 编辑器窗口添加文件事件 */
export const MONACO_EDITOR_ADD_ITEM = "monaco-editor-add-item";

/** 打开或复用独立「Monaco 编辑器」窗口；窗口 label 固定为 monaco-editor。 */
export async function openOrFocusMonacoEditorWindow(payload: MonacoEditorWindowPayload | MonacoEditorWindowPayload[]): Promise<void> {
    const labels = await WebviewWindow.getAll();
    // 不特定具体的label，只需要找到一个编辑窗口即可
    const existingWin = labels.find((win) => win.label.startsWith("monaco-editor-"));
    if (existingWin) {
        emitTo({ kind: "Window", label: existingWin.label }, MONACO_EDITOR_ADD_ITEM, payload).catch((e) => {
            console.error("send MONACO_EDITOR_ADD_ITEM error", e);
        });
        await existingWin.show();
        await existingWin.setFocus();
        return;
    }
    await createNewWindow(
        `monaco-editor-${uuid()}`,
        "monaco-editor",
        ``,
        {
            width: 800,
            height: 680,
        },
        payload,
    );
}

/** 上传远端同名文件冲突处理 */
export type UploadConflictAction = "skip" | "overwrite" | "copy" | "cancel";

/** 上传冲突窗口初始化 payload */
export type UploadConflictWindowPayload = {
    winId: string; // 窗口 ID
    taskId: string; // 任务 ID
    from: string; // 打开窗口的来源窗口
    fileName: string; // 文件名
    localPath: string; // 本地文件路径
    remotePath: string; // 远端文件路径
    last: boolean; // 是否是最后一个文件
};

/** 上传冲突窗口返回 payload */
export type UploadConflictResolvedPayload = {
    taskId: string;
    action: UploadConflictAction;
    applyToAll: boolean;
};

export const UPLOAD_CONFLICT_RESOLVED_EVENT = "upload-conflict-resolved";
export const UPLOAD_CONFLICT_DATA_EVENT = "upload-conflict-data";

/** 打开独立「上传冲突选择」窗口并等待用户选择。 */
export async function openUploadConflictWindow(payload: Omit<UploadConflictWindowPayload, "from">): Promise<UploadConflictResolvedPayload> {
    return new Promise(async (resolve) => {
        const data: UploadConflictWindowPayload = {
            ...payload,
            from: getCurrentWindow().label,
        };
        const label = `upload-conflict-${payload.winId}`;
        const close = await listen<UploadConflictResolvedPayload>(UPLOAD_CONFLICT_RESOLVED_EVENT, (event) => {
            if (event.payload.taskId !== data.taskId) return;
            resolve(event.payload);
            close();
        });
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
            await existing.show();
            await existing.setFocus();
            emitTo<UploadConflictWindowPayload>({ kind: "Window", label }, UPLOAD_CONFLICT_DATA_EVENT, data);
        } else {
            const win = await createNewWindow(
                label,
                "upload-conflict",
                "",
                {
                    width: 520,
                    height: 280,
                    resizable: true,
                },
                data,
            );
            await win.show();
            await win.setFocus();
        }
    });
}

/** 打开子窗口 payload */
export type ChildWindowPayload = {
    x: number;
    y: number;
    width: number;
    height: number;
    fullscreen: boolean;
} & DragStartPayload;

/** 打开或复用子窗口；窗口 label 固定为 child-${item.id}。 */
export async function openOrFocusChildWindow(item: ChannelInstance, payload: ChildWindowPayload) {
    createNewWindow(
        `child-${item.sessionId}`,
        "child",
        "",
        {
            x: payload.x,
            y: payload.y,
            width: document.body.clientWidth,
            height: document.body.clientHeight,
            fullscreen: payload.fullscreen,
        },
        {
            window: payload.window,
            instance: payload.instance,
            snapshot: payload.snapshot,
        } as DragStartPayload,
    );
}

function platformWindowChrome(): Pick<WindowOptions, "decorations" | "titleBarStyle"> {
    if (type() === "macos") {
        return { decorations: true, titleBarStyle: "overlay" };
    }
    return { decorations: false };
}

/** 创建新窗口 */
async function createNewWindow(label: string, tp: AppType, queryStr: string, params: Omit<WebviewOptions, "x" | "y" | "width" | "height"> & WindowOptions, data: unknown): Promise<WebviewWindow> {
    once<AppStartOkPayload>(APP_START_OK_EVENT, (e) => {
        const okLabel = e.payload.label;
        if (okLabel !== label) return;
        emitTo({ kind: "Window", label: label }, WEBVIEW_INIT_DATA_EVENT, data).catch((e) => {
            console.error("send WEBVIEW_INIT_DATA_EVENT error", e);
        });
    });
    const win = new WebviewWindow(label, {
        url: `index.html?tp=${tp}${queryStr}`,
        title: "",
        center: false,
        resizable: true,
        transparent: true,
        ...platformWindowChrome(),
        ...params,
    });
    if (type() === "macos") {
        win.once("tauri://created", () => {
            invoke("disable_native_fullscreen", { label }).catch(console.error);
        });
    }
    return win;
}

export function getMainWinLabel() {
    return mainWinLabel;
}

/** 获取所有能够最晚主窗口的label */
export async function mainLabels(): Promise<string[]> {
    const labels = await WebviewWindow.getAll();
    return labels.filter((win) => win.label.startsWith("main") || win.label.startsWith("child-")).map((win) => win.label);
}

let mainWinLabel: string | null = "main";

async function __getMainWinLabel() {
    const labels = await WebviewWindow.getAll();
    const main = labels.find((win) => win.label.startsWith("main"));
    if (main) {
        return main.label;
    }
    const minChild = labels.filter((win) => win.label.startsWith("child-")).sort()[0];
    if (minChild) {
        return minChild.label;
    }
    return null;
}

listen<{ label: string }>("tauri://window-created", async ({ payload }) => {
    // 获取主窗口 label
    // hild-开头的是子窗口 也可以作为主窗口存在
    mainWinLabel = await __getMainWinLabel();
});

listen<string>("tauri://window-destroyed", async ({ payload }) => {
    if ((await mainLabels()).length === 0) {
        // 没有主窗口了 关闭当前窗口
        getCurrentWindow().destroy();
    }
    mainWinLabel = await __getMainWinLabel();
});
