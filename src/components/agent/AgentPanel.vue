<script setup lang="ts">
import { hydrateAgentRuntimeContext } from "@/agent/runtimeContext.js";
import SessionBar from "./SessionBar.vue";
import { CommandQueue, PromptInput } from "./elements";
import { useAgentSessions } from "./useAgentSessions";
import type { AgentChatMessage, AgentContextMemory, CommandQueueItem } from "@/agent/types";

type AgentItemInst = InstanceType<typeof AgentItem>;

defineOptions({ name: "AgentPanel" });
void hydrateAgentRuntimeContext();
const props = defineProps<{ servers: ChannelInstance[] }>();

/** 同一组服务器顺序不影响分组，排序后作为历史会话目录键。 */
const projectId = computed(() => {
    return props.servers
        .map((server) => server.server.id)
        .sort()
        .join(",");
});

const {
    activeId,
    allTabs,
    oepnTabs,
    selectSession,
    createSessionTab,
    closeSession,
    closeOthers,
    closeAll,
    closeCompleted,
    deleteSession,
    saveSession,
} = useAgentSessions(projectId.value);

const runningIds = ref<string[]>([]);

/** 按会话 id 保存 AgentItem 实例；shallow 避免把组件实例做成深层响应式。 */
const agentItemRef = ref<Record<string, AgentItemInst>>({});

const currentAgent = computed(() => agentItemRef.value[activeId.value]);

/** 当前会话的命令队列；agentProxy 是 useAgent 返回的普通对象，里面的 ref 需要手动 .value。 */
const commandQueueItems = computed<CommandQueueItem[]>(() => currentAgent.value?.agentProxy?.commandQueue.value ?? []);

const compressionStatus = computed(() => currentAgent.value?.agentProxy?.compressionState.value.status ?? "idle");
const compressionTitle = computed(() => currentAgent.value?.agentProxy?.compressionState.value.message ?? "压缩上下文");
const compressionDisabled = computed(() => {
    const proxy = currentAgent.value?.agentProxy;
    return !proxy?.initialized.value || proxy.loading.value || proxy.compressionState.value.status === "running";
});

function setAgentItemRef(id: string) {
    return (el: Element | ComponentPublicInstance | null) => {
        if (el) {
            agentItemRef.value[id] = el as AgentItemInst;
        } else {
            delete agentItemRef.value[id];
        }
    };
}

function messageChange(id: string, messages: AgentChatMessage[], status: boolean, contextMemory: AgentContextMemory) {
    if (status) {
        // 同一会话流式期间可能多次上报（如插入模型切换提示），避免重复入列。
        if (!runningIds.value.includes(id)) runningIds.value.push(id);
    } else {
        // 原写法 filter((id) => id !== id) 参数遮蔽恒为 false，会把所有会话的运行标记清空。
        runningIds.value = runningIds.value.filter((item) => item !== id);
    }
    saveSession(id, messages, status, contextMemory);
}

/** 用量弹层按钮只操作当前激活会话；错误会保留在按钮 title 中供用户查看。 */
function compressCurrentContext() {
    void currentAgent.value?.compressContext().catch(() => undefined);
}
</script>

<template>
    <section class="agent-panel">
        <SessionBar
            :tabs="oepnTabs"
            :active-id="activeId || ''"
            :history="allTabs"
            :running-ids="runningIds"
            @select="selectSession"
            @create="createSessionTab"
            @close="closeSession"
            @close-others="closeOthers"
            @close-all="closeAll"
            @close-completed="closeCompleted"
            @delete-history="deleteSession"
        />
        <template v-for="session in oepnTabs" :key="session.id">
            <AgentItem
                :ref="setAgentItemRef(session.id)"
                :visible="session.id === activeId"
                :servers="servers"
                :thread-id="session.id"
                :history="session.messages"
                :context-memory="session.contextMemory"
                @change="(messages, status, contextMemory) => messageChange(session.id, messages, status, contextMemory)"
            />
        </template>
        <footer class="agent-panel-footer">
            <!-- 命令队列面板：跟随当前激活会话，展示在输入框正上方，可折叠。 -->
            <CommandQueue :items="commandQueueItems" />
            <PromptInput
                :disabled="!currentAgent?.agentProxy?.agent || !currentAgent?.agentProxy?.initialized || compressionStatus === 'running'"
                :loading="currentAgent?.loading"
                :agent="currentAgent?.agentProxy?.agent.value"
                :empty-message="!allTabs.some((v) => v.id === activeId)"
                :context-usage="currentAgent?.agentProxy?.contextUsage.value"
                :compression-status="compressionStatus"
                :compression-title="compressionTitle"
                :compression-disabled="compressionDisabled"
                @submit="currentAgent?.submit"
                @stop="currentAgent?.stop"
                @compress-context="compressCurrentContext"
            />
            <p class="agent-panel-hint">Agent 可能会出错，请在执行重要操作前核对结果。</p>
        </footer>
    </section>
</template>

<style scoped lang="scss">
/* 只保留本组件模板实际使用的样式；agent-user-* 等消息样式属于子组件 AgentItem，scoped 无法穿透，已在 AgentItem.vue 中定义。 */
.agent-panel {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    /* 配置弹窗需要越过左侧分隔条覆盖到终端区域，因此面板不能裁剪左侧溢出内容。 */
    overflow: visible;
    z-index: 20;
}
.agent-panel-footer {
    flex: 0 0 auto;
    padding: 10px 3px;
}
.agent-panel-hint {
    margin: 6px auto 0;
    text-align: center;
    font-size: var(--font-size-xs);
}
</style>
