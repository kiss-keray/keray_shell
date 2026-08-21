<script setup lang="ts">
defineOptions({
    name: "AppPrompt",
});

const props = withDefaults(
    defineProps<{
        title?: string;
        message?: string;
        modelValue?: string;
        placeholder?: string;
        confirmText?: string;
        cancelText?: string;
        /** 纯确认场景可关掉输入框，只保留标题、说明和按钮。 */
        showInput?: boolean;
        /** 危险确认：主按钮使用 error 样式。 */
        danger?: boolean;
        /** 警告确认：主按钮使用 warning 样式。 */
        warning?: boolean;
    }>(),
    {
        title: "请输入",
        message: "",
        modelValue: "",
        placeholder: "",
        confirmText: "确定",
        cancelText: "取消",
        showInput: true,
        danger: false,
        warning: false,
    },
);

const emit = defineEmits<{
    (e: "confirm", value: string): void;
    (e: "cancel"): void;
}>();

const inputValue = ref(props.modelValue);
const inputRef = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);

watch(
    () => props.modelValue,
    (val) => {
        inputValue.value = val;
    },
);

function onConfirm() {
    emit("confirm", inputValue.value);
}

function keydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
        onConfirm();
    } else if (e.key === "Escape") {
        emit("cancel");
    }
}

onMounted(() => {
    if (props.showInput) {
        inputRef.value?.focus();
        return;
    }
    // 纯确认没有输入框，焦点落到对话框才能响应 Enter / Escape。
    dialogRef.value?.focus();
});
</script>

<template>
    <div class="prompt-mask" @click="emit('cancel')">
        <div ref="dialogRef" class="prompt-dialog" role="dialog" aria-modal="true" tabindex="-1" @click.stop @keydown="keydown">
            <p class="prompt-title">{{ props.title }}</p>
            <p v-if="props.message" class="prompt-message">{{ props.message }}</p>
            <SystemInput v-if="props.showInput" ref="inputRef" v-model="inputValue" class="prompt-input" :placeholder="props.placeholder" @keydown="keydown" />
            <div class="prompt-actions">
                <button type="button" class="prompt-btn secondary" @click="emit('cancel')">{{ props.cancelText }}</button>
                <button type="button" class="prompt-btn" :class="{ danger: props.danger, warning: props.warning }" @click="onConfirm">{{ props.confirmText }}</button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.prompt-mask {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(2px);
}

.prompt-dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 16px;
    border-radius: 10px;
    outline: none;
}

.prompt-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 600;
}

.prompt-message {
    margin: 8px 0 0;
    font-size: var(--font-size-md);
    line-height: 1.45;
    white-space: pre-wrap;
}

.prompt-input {
    width: 100%;
    margin-top: 10px;
    color: inherit;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px 8px;
    line-height: 1.3;
    outline: none;
}

.prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
}

.prompt-btn {
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 12px;
    cursor: pointer;
}

.prompt-btn.secondary {
}
</style>
