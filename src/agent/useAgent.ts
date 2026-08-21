import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { LangGraphAgent } from "./agent";
import { uiMessagesToGraphMessages } from "./conversation/restore";
import { buildAgentInput, estimateInputTokens } from "./input";
import type {
    AgentChatMessage,
    AgentStreamEvent,
    AgentPromptSubmitOptions,
    AgentInputMessage,
    AgentResponseMessage,
    AgentContextUsage,
    AgentContextMemory,
    AgentCompressionState,
    ContextCompressionResult,
    CommandQueueItem,
    AgentNoticeMessage,
} from "@/agent/types";
import { getAgentRuntimeContext } from "./runtimeContext";
import { computeContextUsage } from "./context";
import { DEFAULT_COMPRESSION_STATE } from "./contextCompression";

/**
 * 只管理单个agent实例的生命周期、会话状态和流事件映射。
 */
export function useAgent(
    servers: ChannelInstance[],
    threadId: string,
    messages: AgentChatMessage[],
    initialContextMemory?: AgentContextMemory,
) {
    const agent = shallowRef<LangGraphAgent>(); // agent实例
    const initialized = ref(false);
    const loading = ref(false); // 是否正在流式
    let disposed = false; // 是否已卸载
    const contextUsage = shallowRef<AgentContextUsage>();
    const contextMemory = shallowRef<AgentContextMemory>(initialContextMemory ?? { summary: "", summarizedMessageCount: 0 });
    /** 状态由压缩模块发布；这里的 shallowRef 只负责把自动/手动事件接进 Vue。 */
    const compressionState = shallowRef<AgentCompressionState>(DEFAULT_COMPRESSION_STATE);
    const commandQueue = ref<CommandQueueItem[]>([]);
    /** 当前流式的停止控制器；stop() 触发后信号一路传到模型 HTTP 请求。 */
    let streamAbort: AbortController | undefined;
    /** 手动压缩独立于回复流；组件卸载时也要中止，避免后台继续消耗 token。 */
    let compressionAbort: AbortController | undefined;
    let offCompressionState: (() => void) | undefined;

    /** 异步创建 Agent；若组件已卸载，立即释放迟到的实例，避免残留文件监听。 */
    async function initialize() {
        const instance = await LangGraphAgent.create(
            {
                commandQueueCall: (item) => {
                    // 注意回调参数与 find 回调参数同名会遮蔽：item.id === item.id 恒为 true，
                    // 导致后续每条命令的状态更新都覆盖到队列第一条上，这里必须用不同名参数按 id 匹配。
                    const old = commandQueue.value.find((oldItem) => oldItem.id === item.id);
                    if (old) {
                        Object.assign(old, item);
                    } else {
                        commandQueue.value.push(item);
                    }
                },
            },
            servers,
        );
        if (disposed) {
            instance.dispose();
            return;
        }
        agent.value = instance;
        compressionState.value = instance.getCompressionState();
        offCompressionState = instance.onCompressionStateChange((state) => {
            compressionState.value = state;
        });
        // 将历史消息加载到图里
        const priorMessages = messages.length > 0 ? await uiMessagesToGraphMessages(messages) : [];
        await instance.restoreThreadIfEmpty(threadId, priorMessages, contextMemory.value);
        contextMemory.value = await instance.getThreadContextMemory(threadId);
        await syncContextUsage();
        initialized.value = true;
    }

    /** 提交 PromptInput 传来的本轮文本，并将门面层的增量事件持续写入同一条助手消息。 */
    async function submit(data: AgentPromptSubmitOptions) {
        const currentAgent = agent.value;
        const text = data.content.trim();
        const attachments = data.attachments ?? [];
        // 允许只发图片/附件、不写文字；两者都空才不算一次有效提交。
        if (
            (!text && attachments.length === 0) ||
            loading.value ||
            compressionState.value.status === "running" ||
            !currentAgent ||
            disposed
        )
            return;
        await syncContextUsage();
        // 历史对话可以在 llmCall 前自动压缩，因此这里只校验“固定提示 + 本轮新输入”是否单独就超窗。
        // 若仍把旧 conversation 算进硬限制，恰好需要压缩的请求会在进入图之前被错误拦截。
        {
            const fixedTokens =
                contextUsage.value?.segments.filter((item) => item.key !== "conversation").reduce((acc, item) => acc + item.tokens, 0) ?? 0;
            const nowInputTokens = await estimateInputTokens(data);
            const setContextWindowTokens = currentAgent.getModelConfig().contextWindowTokens;
            if (fixedTokens + nowInputTokens > setContextWindowTokens) {
                throw new Error(`本轮输入加固定提示已超过上下文窗口设置: ${setContextWindowTokens}`);
            }
        }
        loading.value = true;

        const userMessage: AgentInputMessage = {
            id: crypto.randomUUID(),
            role: "user",
            content: text,
            attachments: attachments,
            skillNames: data.skillNames,
        };
        messages.push(userMessage);
        // 流式阶段会持续改这条助手消息。必须先做成响应式对象再推进列表：
        // 若只改 push 前的普通对象，Vue 收不到属性更新，思考过程要等到下次发送才出现。
        const answer: AgentResponseMessage = reactive({
            id: crypto.randomUUID(),
            role: "assistant",
            reasoning: "",
            statusLines: [],
            tools: [],
            timeline: [],
            streaming: true,
            content: "",
        });
        messages.push(answer);

        const controller = new AbortController();
        streamAbort = controller;
        try {
            const agentInput = await buildAgentInput(data);

            for await (const event of currentAgent.stream(agentInput, { threadId, signal: controller.signal })) {
                // 信号已中断底层流时，剩余事件不再写入消息，尽快退出循环。
                if (controller.signal.aborted) break;
                if (event.type === "usage") {
                    answer.usageMetadata = event.data;
                } else {
                    applyStreamEvent(answer, event);
                }
            }
            // 主动停止不算失败：保留已生成的部分内容，只追加一行状态说明。
            if (controller.signal.aborted) {
                finishRunningTools(answer, "cancelled", "已手动停止");
                appendStatus(answer, "已手动停止");
            }
            await syncContextUsage();
            await syncContextMemory();
        } catch (error) {
            // LangGraph 在 abort 时会以异常形式终止迭代，与真正的执行失败区分开。
            if (controller.signal.aborted) {
                finishRunningTools(answer, "cancelled", "已手动停止");
                appendStatus(answer, "已手动停止");
            } else {
                const message = getErrorMessage(error);
                finishRunningTools(answer, "error", message);
                answer.error = message;
                appendStatus(answer, "本轮执行失败");
            }
        } finally {
            answer.streaming = false;
            loading.value = false;
            streamAbort = undefined;
        }
    }

    /** 停止当前流式输出；没有正在运行的流时是空操作。 */
    function stop() {
        streamAbort?.abort();
    }

    /** 用户主动压缩当前会话；公开给 AgentItem/AgentPanel 的按钮动作复用。 */
    async function compressContext(): Promise<ContextCompressionResult | undefined> {
        const currentAgent = agent.value;
        if (!currentAgent || disposed || loading.value || compressionState.value.status === "running") return;
        const controller = new AbortController();
        compressionAbort = controller;
        try {
            const result = await currentAgent.compressContext(threadId, controller.signal);
            contextMemory.value = result.memory;
            await syncContextUsage();
            return result;
        } finally {
            compressionAbort = undefined;
        }
    }

    async function syncContextMemory() {
        const currentAgent = agent.value;
        if (!currentAgent) return;
        contextMemory.value = await currentAgent.getThreadContextMemory(threadId);
    }

    async function syncContextUsage() {
        const currentAgent = agent.value!;
        const conversationText = await currentAgent.getThreadConversationText(threadId);
        const config = currentAgent.getModelConfig();
        const runtimeContext = getAgentRuntimeContext();
        contextUsage.value = computeContextUsage({
            systemPromptBody: currentAgent.promptManager.getPromptBody(),
            skillCatalog: currentAgent.promptManager.getSkillCatalog(),
            tools: currentAgent.tools,
            conversationText,
            contextWindowTokens: config.contextWindowTokens,
            reasoningEffort: config.reasoningEffort,
            servers: servers,
            commandExecution: runtimeContext.commandExecution,
            accessMode: runtimeContext.accessMode,
        });
    }

    onMounted(() => {
        void initialize();
    });

    onBeforeUnmount(() => {
        disposed = true;
        // 组件卸载时中断未完成的流，避免后台请求继续消耗 token。
        streamAbort?.abort();
        compressionAbort?.abort();
        offCompressionState?.();
        agent.value?.dispose();
        agent.value = undefined;
    });

    return {
        agent,
        initialized,
        loading,
        submit,
        stop,
        contextUsage,
        contextMemory,
        compressionState,
        compressContext,
        commandQueue,
    };
}

/** 将 Agent 门面事件映射到 AI Elements Vue 的消息、Reasoning 和 Tool 视图模型。 */
function applyStreamEvent(message: AgentResponseMessage, event: AgentStreamEvent) {
    if (event.type === "text-delta") {
        // 只收模型对用户说的话；工具输出在门面层已从 messages 流剔除，不会进 content。
        message.content += event.text;
    } else if (event.type === "reasoning-delta") {
        message.reasoning += event.text;
        appendReasoningBlock(message, event.text);
    } else if (event.type === "status") {
        appendStatus(message, event.text);
    } else if (event.type === "tool-prepare") {
        // 参数仍在模型流里拼接，先挂载轻量工具卡片；避免长参数每个 delta 都触发 CodeBlock 重渲染。
        message.tools.push({
            id: event.id,
            name: event.name,
            input: undefined,
            state: "preparing",
        });
        ensureTimeline(message).push({ type: "tool", id: event.id });
    } else if (event.type === "tool-start") {
        const pendingId = event.pendingId ?? event.id;
        const pendingTool = message.tools.find((item) => item.id === pendingId && item.state === "preparing");
        if (pendingTool) {
            // 最终 tool_call_id 可能和流式阶段的临时 ID 不同；工具和时间线必须一起换成最终 ID。
            pendingTool.id = event.id;
            pendingTool.name = event.name;
            pendingTool.input = event.input;
            pendingTool.state = "running";
            for (const item of ensureTimeline(message)) {
                if (item.type === "tool" && item.id === pendingId) item.id = event.id;
            }
        } else {
            // 某些模型不输出 tool_call_chunks，保留原有的完整调用兜底路径。
            message.tools.push({
                id: event.id,
                name: event.name,
                input: event.input,
                state: "running",
            });
            ensureTimeline(message).push({ type: "tool", id: event.id });
        }
    } else if (event.type === "tool-result") {
        const tool = message.tools.find((item) => item.id === event.id);
        if (!tool) return;
        tool.output = event.output;
        tool.state = "completed";
    }
}

/** 流在工具返回前被停止或失败时，收口所有悬空工具，避免历史记录一直显示“执行中”。 */
function finishRunningTools(message: AgentResponseMessage, state: "cancelled" | "error", output: string) {
    for (const tool of message.tools) {
        // 参数接收中和真实执行中都属于悬空状态，停止或异常时需要统一收口。
        if (tool.state !== "preparing" && tool.state !== "running") continue;
        tool.state = state;
        tool.output ??= output;
    }
}

function appendStatus(message: AgentResponseMessage, text: string) {
    if (message.statusLines.at(-1) !== text) message.statusLines.push(text);
}

/** 保证消息带有可写时间线；hydrate 进来的旧记录可能没有这个字段。 */
function ensureTimeline(message: AgentResponseMessage) {
    message.timeline ??= [];
    return message.timeline;
}

/**
 * 同一轮连续 reasoning-delta 拼进同一块；上一块是工具后再来推理则新开一块。
 * 这样前端才能按「思考 → 工具 → 思考 → 工具」交错渲染，而不是把全部工具堆在思考末尾。
 */
function appendReasoningBlock(message: AgentResponseMessage, text: string) {
    const timeline = ensureTimeline(message);
    const last = timeline.at(-1);
    if (last?.type === "reasoning") {
        last.text += text;
        return;
    }
    timeline.push({ type: "reasoning", id: crypto.randomUUID(), text });
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
