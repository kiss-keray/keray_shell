<script setup lang="ts">
/**
 * AI Elements Vue Loader。首包 token 到达前表示 Agent 已受理请求。
 */
defineOptions({ name: "AgentLoader" });

withDefaults(defineProps<{ label?: string }>(), { label: "正在生成" });
</script>

<template>
    <div class="ai-loader" role="status" aria-live="polite" :aria-label="label">
        <Icon icon="mdi:loading" class="ai-loader-icon app-loading-spin" />
        <span>{{ label }}</span>
    </div>
</template>

<style scoped lang="scss">
.ai-loader {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: var(--font-size-sm);
}
.ai-loader-icon {
    font-size: 18px;
}
</style>
