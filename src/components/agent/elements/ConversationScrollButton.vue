<script setup lang="ts">
import { useStickToBottomContext } from "vue-stick-to-bottom";

/**
 * AI Elements Vue ConversationScrollButton。
 * 用户上翻历史后出现，点按回到流式输出底部。
 */
defineOptions({ name: "AgentConversationScrollButton" });

const { isAtBottom, scrollToBottom } = useStickToBottomContext();
</script>

<template>
    <button v-if="!isAtBottom" type="button" class="ai-conversation-scroll" title="回到底部" aria-label="回到底部" @click="scrollToBottom()">
        <Icon icon="mdi:arrow-down" />
    </button>
</template>

<style scoped lang="scss">
.ai-conversation-scroll {
    position: absolute;
    bottom: 16px;
    left: 50%;
    z-index: 2;
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 999px;
    transform: translateX(-50%);
    cursor: pointer;
    font-size: 18px;
}
</style>
