<script setup lang="ts">
import type { AgentTimelineItem, AgentToolStep } from "@/agent/types";
import type { UsageMetadata } from "@langchain/core/messages";
import Tool from "./Tool.vue";

defineOptions({ name: "AgentReasoning" });

const props = withDefaults(
    defineProps<{
        /** 按发生顺序交错的思考块和工具引用，由 resolveAgentTimeline 提供。 */
        timeline: AgentTimelineItem[];
        tools: AgentToolStep[];
        streaming?: boolean;
        /** 流水线当前一步；只在流式时作为标题，结束后不再堆历史。 */
        status?: string;
        /** 本轮回答的 token 用量，流结束时由 agent 门面汇总下发；历史消息从会话 JSON 恢复。 */
        usage?: UsageMetadata;
    }>(),
    { streaming: false, status: "", usage: undefined },
);
const open = ref(false);
const startedAt = ref<number>();
const duration = ref<number>();

/** token 数统一按 k 缩写：1234 → "1.2k"，不足 1k 也保留一位小数（456 → "0.5k"），保证单位一致。 */
function formatTokenK(value: number): string {
    return `${(value / 1000).toFixed(1)}k`;
}

/**
 * 标题右侧的用量摘要，↑ 为输入、↓ 为输出；usage 缺失（旧会话或流式中）时不显示。
 * 模型侧报过缓存命中（input_token_details.cache_read）时，在输入后追加缓存量。
 */
const usageText = computed(() => {
    const usage = props.usage;
    if (!usage) return "";
    const parts = [`↑ ${formatTokenK(usage.input_tokens)}`];
    const cacheRead = usage.input_token_details?.cache_read;
    if (cacheRead) parts.push(`缓存 ${formatTokenK(cacheRead)}`);
    parts.push(`↓ ${formatTokenK(usage.output_tokens)}`);
    return parts.join(" · ");
});

/** 悬浮提示用精确值，便于和模型后台账单核对；无缓存命中时不带缓存段。 */
const usageTitle = computed(() => {
    const usage = props.usage;
    if (!usage) return "";
    const cacheRead = usage.input_token_details?.cache_read;
    const input = cacheRead ? `输入 ${usage.input_tokens}（其中缓存命中 ${cacheRead}）` : `输入 ${usage.input_tokens}`;
    return `${input} / 输出 ${usage.output_tokens} tokens`;
});

type ReasoningBlock = { key: string; kind: "reasoning"; text: string } | { key: string; kind: "tool"; tool: AgentToolStep };

/**
 * 把时间线里的 tool id 解析成完整步骤。
 * 连续 reasoning-delta 已在写入时合并，这里按原顺序交错输出思考段落和工具夹头。
 */
const blocks = computed<ReasoningBlock[]>(() => {
    const next: ReasoningBlock[] = [];
    for (const item of props.timeline) {
        if (item.type === "reasoning") {
            if (item.text) next.push({ key: `reasoning-${item.id}`, kind: "reasoning", text: item.text });
            continue;
        }
        const tool = props.tools.find((step) => step.id === item.id);
        if (tool) next.push({ key: `tool-${item.id}`, kind: "tool", tool });
    }
    return next;
});

const visible = computed(() => props.streaming || blocks.value.length > 0);

watch(
    () => props.streaming,
    (streaming, previous) => {
        if (streaming) {
            open.value = true;
            startedAt.value ??= Date.now();
        } else if (previous && startedAt.value) {
            duration.value = Math.max(1, Math.ceil((Date.now() - startedAt.value) / 1000));
            startedAt.value = undefined;
            // AI Elements Vue 默认在流结束后收起推理，避免长期占用正文空间。
            window.setTimeout(() => (open.value = false), 800);
        }
    },
    { immediate: true },
);
</script>

<template>
    <!-- 流式开始时时间线往往还是空的；有工具或推理块时也要挂载。 -->
    <section v-if="visible" class="ai-reasoning">
        <button type="button" class="ai-reasoning-trigger" :aria-expanded="open" @click="open = !open">
            <Icon icon="mdi:brain" />
            <span v-if="streaming" class="ai-reasoning-shimmer">{{ status || "正在思考" }}</span>
            <span v-else>{{ duration ? `思考了 ${duration} 秒` : "思考过程" }}</span>
            <!-- 本轮 token 用量：仅流结束且拿到 usage 后显示，title 里放精确值方便核对。 -->
            <span v-if="!streaming && usageText" class="ai-reasoning-usage" :title="usageTitle">
                {{ usageText }}
            </span>
            <Icon icon="mdi:chevron-down" class="ai-reasoning-chevron" :class="{ open }" />
        </button>
        <Transition name="ai-reasoning">
            <div v-show="open" class="ai-reasoning-body">
                <template v-for="block in blocks" :key="block.key">
                    <div v-if="block.kind === 'reasoning'" class="ai-reasoning-content">{{ block.text }}</div>
                    <Tool v-else-if="block.kind === 'tool'" :tool="block.tool" />
                </template>
            </div>
        </Transition>
    </section>
</template>

<style scoped lang="scss">
.ai-reasoning {
    width: 100%;
}
.ai-reasoning-trigger {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 7px;
    padding: 4px 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-sm);
    text-align: left;
    user-select: none;
    -webkit-user-select: none;
}
.ai-reasoning-chevron {
    margin-left: auto;
    transition: transform 0.2s ease;
    &.open {
        transform: rotate(180deg);
    }
}
/* 用量摘要比标题小一号，等宽数字避免流式刷新时抖动；颜色在 theme.*.scss 的 .ai-reasoning-usage 中。 */
.ai-reasoning-usage {
    flex: none;
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
}
.ai-reasoning-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 5px;
    padding-left: 22px;
}
.ai-reasoning-content {
    font-size: var(--font-size-sm);
    line-height: 1.55;
    white-space: pre-wrap;
}
.ai-reasoning-shimmer {
    background-size: 220% 100%;
    background-clip: text;
    color: transparent;
    animation: ai-shimmer 1.6s linear infinite;
}
.ai-reasoning-enter-active,
.ai-reasoning-leave-active {
    transition: opacity 0.16s ease;
}
.ai-reasoning-enter-from,
.ai-reasoning-leave-to {
    opacity: 0;
}
@keyframes ai-shimmer {
    to {
        background-position: -220% 0;
    }
}
</style>
