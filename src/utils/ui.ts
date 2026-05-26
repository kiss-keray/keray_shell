import { createApp, h, ref, type VNodeChild } from "vue";
import Confirm from "@/components/Confirm.vue";
import Prompt from "@/components/Prompt.vue";
import { PRIORITY_HIGHEST } from "@/stores/keyEvent";

/** 显示toast */
export function showToast(msg: string, type: "success" | "error" | "warning" | "info" = "info") {
    if (!msg) return;

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
            if (host && host.childElementCount === 0) {
                host.remove();
            }
        }, fadeMs);
    }, stayMs);
}

/** 确认弹窗正文：字符串（支持 v-html）或 JSX / VNode */
export type ConfirmMessage = string | VNodeChild | (() => VNodeChild);

type ShowConfirmOptions = {
    title?: string;
    message: ConfirmMessage;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
};


/** 显示确认弹窗 */
export function showConfirm(options: ShowConfirmOptions): Promise<boolean> {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const visible = ref(true);

    return new Promise((resolve) => {
        const app = createApp({
            setup() {
                let unregister: () => void = () => {};
                const close = (result: boolean) => {
                    visible.value = false;
                    resolve(result);
                    // 等待一次渲染，再卸载组件，避免闪烁
                    queueMicrotask(() => {
                        app.unmount();
                        container.remove();
                        unregister();
                    });
                };
                unregister = useKeyEventStore().register((event) => {
                    if (event.key === "Escape") {
                        close(false);
                        return true;
                    } else if (event.key === "Enter") {
                        close(true);
                        return true;
                    }
                    return false;
                }, PRIORITY_HIGHEST);

                return () =>
                    h(Confirm, {
                        visible: visible.value,
                        title: options.title,
                        message: options.message,
                        confirmText: options.confirmText,
                        cancelText: options.cancelText,
                        danger: options.danger,
                        onConfirm: () => close(true),
                        onCancel: () => close(false),
                    });
            },
        });

        app.mount(container);
    });
}

type ShowPromptOptions = {
    title?: string;
    message?: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
};
/** 显示输入弹窗 */
export function showPrompt(options: ShowPromptOptions): Promise<string | null> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    return new Promise((resolve) => {
        const app = createApp({
            setup() {
                const close = (result: string | null) => {
                    resolve(result);
                    queueMicrotask(() => {
                        app.unmount();
                        container.remove();
                    });
                };

                return () =>
                    h(Prompt, {
                        title: options.title,
                        message: options.message,
                        modelValue: options.defaultValue,
                        placeholder: options.placeholder,
                        confirmText: options.confirmText,
                        cancelText: options.cancelText,
                        onConfirm: (value: string) => close(value),
                        onCancel: () => close(null),
                    });
            },
        });

        app.mount(container);
    });
}
