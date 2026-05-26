import PermissionEditor from "@/components/PermissionEditor.vue";

type ShowPermissionEditorOptions = {
    title?: string;
    path?: string;
    defaultValue?: number;
    confirmText?: string;
    cancelText?: string;
};

/** 显示文件权限编辑弹窗 */
export function showPermissionEditor(options: ShowPermissionEditorOptions): Promise<number | null> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    return new Promise((resolve) => {
        const app = createApp({
            setup() {
                const close = (result: number | null) => {
                    resolve(result);
                    queueMicrotask(() => {
                        app.unmount();
                        container.remove();
                    });
                };

                return () =>
                    h(PermissionEditor, {
                        title: options.title,
                        path: options.path,
                        modelValue: options.defaultValue ?? 0,
                        confirmText: options.confirmText,
                        cancelText: options.cancelText,
                        onConfirm: (value: number) => close(value),
                        onCancel: () => close(null),
                    });
            },
        });

        app.mount(container);
    });
}
