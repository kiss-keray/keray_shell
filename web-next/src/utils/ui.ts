import type { ReactNode } from "react";
import { create } from "zustand";
import { getUiFontSizeCss } from "@/utils/fontSize";

/** 确认弹窗正文：字符串（支持 dangerouslySetInnerHTML）或 ReactNode */
export type ConfirmMessage = string | ReactNode | (() => ReactNode);

export type ShowConfirmOptions = {
    title?: string;
    message: ConfirmMessage;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
};

export type ShowPromptOptions = {
    title?: string;
    message?: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
};

export type ShowPermissionEditorOptions = {
    title?: string;
    path?: string;
    defaultValue?: number;
    confirmText?: string;
    cancelText?: string;
};

export type ConfirmRequest = ShowConfirmOptions & {
    id: string;
    kind: "confirm";
    resolve: (value: boolean) => void;
};

export type PromptRequest = ShowPromptOptions & {
    id: string;
    kind: "prompt";
    resolve: (value: string | null) => void;
};

export type PermissionEditorRequest = ShowPermissionEditorOptions & {
    id: string;
    kind: "permission";
    resolve: (value: number | null) => void;
};

export type ImperativeUIRequest = ConfirmRequest | PromptRequest | PermissionEditorRequest;

type ImperativeUIStore = {
    requests: ImperativeUIRequest[];
    open: (request: ImperativeUIRequest) => void;
    close: (id: string) => void;
};

export const useImperativeUIStore = create<ImperativeUIStore>((set, get) => ({
    requests: [],
    open(request) {
        set({ requests: [...get().requests, request] });
    },
    close(id) {
        set({ requests: get().requests.filter((request) => request.id !== id) });
    },
}));

function nextDialogId(): string {
    return `imperative-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 显示toast */
export function showToast(msg: string, type: "success" | "error" | "warning" | "info" = "info") {
    if (!msg || typeof document === "undefined") return;

    const hostId = "__app_toast_host__";
    let host = document.getElementById(hostId);
    if (!host) {
        host = document.createElement("div");
        host.id = hostId;
        host.style.position = "fixed";
        host.style.top = "20px";
        host.style.right = "20px";
        host.style.zIndex = "9999";
        host.style.display = "flex";
        host.style.flexDirection = "column";
        host.style.gap = "8px";
        host.style.pointerEvents = "none";
        document.body.appendChild(host);
    }

    const toast = document.createElement("div");
    toast.textContent = msg;
    toast.style.pointerEvents = "auto";
    toast.style.padding = "10px 12px";
    toast.style.borderRadius = "8px";
    toast.style.fontSize = getUiFontSizeCss("--font-size-md");
    toast.style.lineHeight = "1.4";
    toast.style.color = "#fff";
    toast.style.boxShadow = "0 4px 14px rgba(0,0,0,0.25)";
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
    toast.style.transition = "opacity 180ms ease, transform 180ms ease";

    if (type === "success") toast.style.background = "#16a34a";
    else if (type === "error") toast.style.background = "#dc2626";
    else if (type === "warning") toast.style.background = "#d97706";
    else toast.style.background = "#2563eb";

    host.appendChild(toast);

    requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    });

    const stayMs = 2200;
    const fadeMs = 180;

    window.setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-6px)";
        window.setTimeout(() => {
            toast.remove();
            if (host && host.childElementCount === 0) host.remove();
        }, fadeMs);
    }, stayMs);
}

/** 显示确认弹窗 */
export function showConfirm(options: ShowConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
        useImperativeUIStore.getState().open({
            id: nextDialogId(),
            kind: "confirm",
            ...options,
            resolve,
        });
    });
}

/** 显示输入弹窗 */
export function showPrompt(options: ShowPromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
        useImperativeUIStore.getState().open({
            id: nextDialogId(),
            kind: "prompt",
            ...options,
            resolve,
        });
    });
}

/** 显示文件权限编辑弹窗 */
export function showPermissionEditor(options: ShowPermissionEditorOptions): Promise<number | null> {
    return new Promise((resolve) => {
        useImperativeUIStore.getState().open({
            id: nextDialogId(),
            kind: "permission",
            ...options,
            resolve,
        });
    });
}
