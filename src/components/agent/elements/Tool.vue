<script setup lang="ts">
import type { AgentToolStep } from "@/agent/types";
import CodeBlock from "./CodeBlock.vue";

defineOptions({ name: "AgentTool" });
const props = defineProps<{ tool: AgentToolStep }>();
// 默认收起，点夹头才展开参数和结果，避免思考过程被日志撑满。
const open = ref(false);

const headerIcon = computed(() => {
    if (props.tool.state === "preparing" || props.tool.state === "running") return "mdi:loading";
    if (props.tool.state === "error") return "mdi:alert-circle-outline";
    if (props.tool.state === "cancelled") return "mdi:stop-circle-outline";
    return "mdi:dots-grid";
});

function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

const inputText = computed(() => formatValue(props.tool.input));
const outputText = computed(() => formatValue(props.tool.output));
/** exec_command 的 stdout/stderr 使用 Shell 块展示，其他字符串工具结果仍按普通日志处理。 */
const outputLanguage = computed(() => {
    if (props.tool.name === "exec_command") return "shell";
    return typeof props.tool.output === "string" ? "log" : "json";
});
</script>

<template>
    <section class="ai-tool" :class="`is-${tool.state}`">
        <button type="button" class="ai-tool-header" :aria-expanded="open" @click="open = !open">
            <Icon :icon="headerIcon" :class="{ 'app-loading-spin': tool.state === 'preparing' || tool.state === 'running' }" />
            <span class="ai-tool-name">{{ tool.name }}</span>
            <Icon icon="mdi:chevron-down" class="ai-tool-chevron" :class="{ open }" />
        </button>
        <div v-show="open" class="ai-tool-content">
            <template v-if="tool.state === 'preparing'">
                <!-- 参数完整前不创建 CodeBlock，避免长参数增量导致昂贵的序列化和高亮。 -->
                <p class="ai-tool-pending">正在接收参数…</p>
            </template>
            <template v-else>
                <p>参数</p>
                <!-- 工具入参/结果用 CodeBlock，保证 pre 右上角始终有复制。 -->
                <CodeBlock :code="inputText" language="json" />
            </template>
            <template v-if="tool.output !== undefined">
                <p>结果</p>
                <CodeBlock :code="outputText" :language="outputLanguage" />
            </template>
            <p v-else-if="tool.state === 'running'" class="ai-tool-pending">执行中…</p>
        </div>
    </section>
</template>

<style scoped lang="scss">
.ai-tool {
    min-width: 0;
}
.ai-tool-header {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-sm);
    text-align: left;
    user-select: none;
    -webkit-user-select: none;
}
.ai-tool-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ai-tool-chevron {
    flex: none;
    font-size: 16px;
    // 收起指向右侧，展开指向下，和 Cursor 工具夹头一致。
    transform: rotate(-90deg);
    transition: transform 0.16s ease;
    &.open {
        transform: rotate(0deg);
    }
}
.ai-tool-content {
    margin-top: 4px;
    padding: 8px 10px 10px;
    border-radius: 8px;
    p {
        margin: 8px 0 4px;
        font-size: var(--font-size-xs);
        &:first-child {
            margin-top: 0;
        }
    }
}
.ai-tool-pending {
    margin-bottom: 0;
}
</style>
