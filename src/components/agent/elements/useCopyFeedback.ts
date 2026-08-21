import { copyText } from "@/utils/project";

/**
 * 代码块、消息操作共用的复制反馈。
 * 复制成功后短暂切换图标，避免连续点击重复写入剪贴板。
 */
export function useCopyFeedback(timeout = 1600) {
    const copied = ref(false);
    let timer: number | undefined;

    async function copy(text: string) {
        const value = text.trim();
        if (!value) return;
        await copyText(value);
        copied.value = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            copied.value = false;
        }, timeout);
    }

    onBeforeUnmount(() => window.clearTimeout(timer));
    return { copied, copy };
}
