<!-- eslint-disable vue/multi-word-component-names -->
<script setup lang="ts">
export type SystemInputExpose = {
    focus: (options?: FocusOptions) => void;
    blur: () => void;
    select: () => void;
};
const inputRef = ref<HTMLInputElement>();
const modelValue = defineModel<string>();
const attrs = useAttrs();
defineExpose<SystemInputExpose>({
    focus: (options?: FocusOptions) => inputRef.value?.focus(options),
    blur: () => inputRef.value?.blur(),
    select: () => inputRef.value?.select(),
});
</script>

<template>
    <input ref="inputRef" v-model="modelValue" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" v-bind="attrs" @keydown.stop="" />
</template>

<style scoped></style>
