<script setup lang="ts">
import { useCopyFeedback } from "./useCopyFeedback";

/**
 * 基于 AI Elements Vue CodeBlock 裁剪。
 * 运维对话里命令、配置和工具输出都走这里，复制按钮固定在 pre 右上角。
 */
defineOptions({ name: "AgentCodeBlock" });

const props = withDefaults(
    defineProps<{
        code: string;
        language?: string;
        filename?: string;
    }>(),
    { language: "", filename: "" },
);

const { copied, copy } = useCopyFeedback();
const label = computed(() => props.filename || props.language);
</script>

<template>
    <div class="ai-code-block" :data-language="language || undefined">
        <span v-if="label" class="ai-code-block-label">{{ label }}</span>
        <button type="button" class="ai-code-block-copy" :title="copied ? '已复制' : '复制'" @click="copy(code)">
            <Icon :icon="copied ? 'mdi:check' : 'mdi:content-copy'" />
        </button>
        <pre>{{ code }}</pre>
    </div>
</template>

<style scoped lang="scss">
.ai-code-block {
    position: relative;
    overflow: hidden;
    border-radius: 7px;
}
.ai-code-block-label {
    position: absolute;
    top: 6px;
    left: 10px;
    z-index: 1;
    max-width: calc(100% - 44px);
    overflow: hidden;
    font-size: var(--font-size-xs);
    line-height: 22px;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
}
.ai-code-block-copy {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 1;
    display: inline-flex;
    width: 26px;
    height: 26px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
}
pre {
    max-height: 180px;
    margin: 0;
    overflow: auto;
    padding: 32px 10px 9px;
    font-size: var(--font-size-xs);
    line-height: 1.45;
    user-select: text;
    -webkit-user-select: text;
    white-space: pre-wrap;
    word-break: break-word;
}
</style>
