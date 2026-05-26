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
    }>(),
    {
        title: "请输入",
        message: "",
        modelValue: "",
        placeholder: "",
        confirmText: "确定",
        cancelText: "取消",
    },
);

const emit = defineEmits<{
    (e: "confirm", value: string): void;
    (e: "cancel"): void;
}>();

const inputValue = ref(props.modelValue);
const inputRef = ref<HTMLInputElement | null>(null);

watch(
    () => props.modelValue,
    (val) => {
        inputValue.value = val;
    },
);

function onConfirm() {
    emit("confirm", inputValue.value);
}

onMounted(() => {
    inputRef.value?.focus();
});
</script>

<template>
    <div class="prompt-mask" @click="emit('cancel')">
        <div class="prompt-dialog" role="dialog" aria-modal="true" @click.stop>
            <p class="prompt-title">{{ props.title }}</p>
            <p v-if="props.message" class="prompt-message">{{ props.message }}</p>
            <input
                ref="inputRef"
                v-model="inputValue"
                class="prompt-input"
                :placeholder="props.placeholder"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                @keydown.enter="onConfirm"
                @keydown.esc="emit('cancel')"
            />
            <div class="prompt-actions">
                <button type="button" class="prompt-btn secondary" @click="emit('cancel')">{{ props.cancelText }}</button>
                <button type="button" class="prompt-btn" @click="onConfirm">{{ props.confirmText }}</button>
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
