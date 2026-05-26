<script setup lang="ts">
import { computed } from "vue";
import type { ConfirmMessage } from "@/utils/ui";

defineOptions({
    name: "AppConfirm",
});

const props = withDefaults(
    defineProps<{
        visible: boolean;
        title?: string;
        message: ConfirmMessage;
        confirmText?: string;
        cancelText?: string;
        danger?: boolean;
    }>(),
    {
        title: "确认操作",
        confirmText: "确定",
        cancelText: "取消",
        danger: false,
    },
);

const emit = defineEmits<{
    (e: "confirm"): void;
    (e: "cancel"): void;
}>();

const isHtmlMessage = computed(() => typeof props.message === "string");

const messageRender = computed(() => {
    if (typeof props.message === "string") return null;
    const content = typeof props.message === "function" ? props.message() : props.message;
    return () => content;
});

function onMaskClick() {
    emit("cancel");
}
</script>

<template>
    <div v-if="props.visible" class="confirm-mask" @click="onMaskClick">
        <div class="confirm-dialog" role="dialog" aria-modal="true" @click.stop>
            <p class="confirm-title">{{ props.title }}</p>
            <div class="confirm-message">
                <div v-if="isHtmlMessage" v-html="props.message as string"></div>
                <component v-else :is="messageRender" />
            </div>
            <div class="confirm-actions">
                <button type="button" class="confirm-btn secondary" @click="emit('cancel')">
                    {{ props.cancelText }}
                </button>
                <button type="button" class="confirm-btn" :class="{ danger: props.danger }" @click="emit('confirm')">
                    {{ props.confirmText }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.confirm-mask {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(2px);
}

.confirm-dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 16px;
    border-radius: 10px;
}

.confirm-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 600;
}

.confirm-message {
    margin: 8px 0 0;
    font-size: var(--font-size-md);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;

    :deep(.confirm-danger-body) {
        display: flex;
        flex-direction: column;
        gap: 8px;
        white-space: normal;
    }

    :deep(.confirm-intro),
    :deep(.confirm-target),
    :deep(.confirm-danger-note) {
        margin: 0;
    }

    :deep(.confirm-target code) {
        display: block;
        margin-top: 4px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: var(--font-size-sm);
        line-height: 1.4;
        word-break: break-all;
        white-space: pre-wrap;
    }

    :deep(.confirm-file-list) {
        margin: 0;
        padding: 0;
        list-style: none;
        max-height: 168px;
        overflow-y: auto;
        border-radius: 6px;
    }

    :deep(.confirm-file-item) {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 10px;

        &:last-child {
            border-bottom: none;
        }
    }

    :deep(.confirm-file-path) {
        font-size: var(--font-size-sm);
        word-break: break-all;
    }

    :deep(.confirm-danger-note) {
        font-size: var(--font-size-sm);
        font-weight: 600;
    }
}

.confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
}

.confirm-btn {
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 5px 12px;
    cursor: pointer;
}

.confirm-btn.secondary {
}

.confirm-btn.danger {
}
</style>
