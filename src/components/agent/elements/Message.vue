<script setup lang="ts">
import type { AgentMessageRole } from "@/agent/types";

defineOptions({ name: "AgentMessage" });
defineProps<{ from: AgentMessageRole }>();
</script>

<template>
    <article class="ai-message" :class="`is-${from}`">
        <slot />
    </article>
</template>

<style scoped lang="scss">
.ai-message {
    width: 100%;
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
    font-size: var(--font-size-md);
    line-height: 1.65;
    /* body 全局禁选；对话正文（含思考、工具日志、markdown）需要能拖选复制。 */
    user-select: text;
    -webkit-user-select: text;

    &.is-user {
        align-self: flex-end;
        justify-content: flex-end;
    }

    &.is-assistant {
        align-self: flex-start;
    }
}
</style>
