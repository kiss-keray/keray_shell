declare global {
    interface Window {
        sid_new_window: string;
    }

    interface Array<T> {
        /** 从数组中移除首个匹配的 item，返回自身以支持链式调用 */
        remove(item: T): this;
    }
}

declare module "monaco-editor/min/vs/nls.messages.zh-cn.js.js";

export {};
