import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, type ConditionalEdgeRouter, type GraphNode } from "@langchain/langgraph";
import {
    buildAgentSystemPromptParts,
    estimateTokens,
    joinAgentSystemPrompt,
    serializeConversationMessages,
    serializeTools,
} from "../context";
import type { ModelConfigManager } from "../config/manager";
import type { PromptManager } from "../prompt/manager";
import { getAgentRuntimeContext } from "../runtimeContext";
import {
    activeContextMessages,
    compressConversationContext,
    normalizeContextMemory,
    renderContextSummary,
    type ContextCompressionTracker,
} from "../contextCompression";
import { AgentState } from "./state";

/**
 * 创建主 Agent 的 llmCall 节点。
 *
 * 每次执行都取当前 ChatModel 和 default.md 展开后的系统提示词。
 * 模型配置、提示词、技能文档都可以热重载，不必 recompile 图。
 */
export function createLlmCallNode(
    modelManager: ModelConfigManager,
    promptManager: PromptManager,
    tools: StructuredToolInterface[],
    servers: ChannelInstance[],
    compressionTracker: ContextCompressionTracker,
): GraphNode<typeof AgentState> {
    return createStreamingLlmCallNode(modelManager, tools, compressionTracker, () => {
        const runtimeContext = getAgentRuntimeContext();
        const modelConfig = modelManager.getConfig();
        return joinAgentSystemPrompt(
            buildAgentSystemPromptParts({
                systemPromptBody: promptManager.getPromptBody(),
                skillCatalog: promptManager.getSkillCatalog(),
                reasoningEffort: modelConfig.reasoningEffort,
                servers: servers,
                commandExecution: runtimeContext.commandExecution,
                accessMode: runtimeContext.accessMode,
            }),
        );
    });
}

/**
 * 可替换系统提示词的 ReAct llmCall。
 * 子 Agent 不能走 default.md：那份运维提示词会诱使它继续 exec_command，形成递归。
 */
export function createStreamingLlmCallNode(
    modelManager: ModelConfigManager,
    tools: StructuredToolInterface[],
    compressionTracker: ContextCompressionTracker,
    buildSystemPrompt: () => string,
): GraphNode<typeof AgentState> {
    return async (state, runnableConfig) => {
        const modelConfig = modelManager.getConfig();
        const model = modelManager.getChatModel();
        const modelWithTools = tools.length > 0 ? model.bindTools(tools) : model;
        const systemPrompt = buildSystemPrompt();
        const reservedTokens = estimateTokens(systemPrompt) + estimateTokens(serializeTools(tools)) + (modelConfig.maxTokens ?? 4_096);
        const historyBudgetTokens = Math.max(1_000, modelConfig.contextWindowTokens - reservedTokens);
        const previousMemory = normalizeContextMemory(
            { summary: state.contextSummary, summarizedMessageCount: state.summarizedMessageCount },
            state.messages.length,
        );
        let compression = {
            memory: previousMemory,
            compressed: false,
            compressedMessageCount: 0,
            modelCalls: 0,
        };
        try {
            compression = await compressConversationContext({
                messages: state.messages,
                memory: previousMemory,
                modelManager,
                historyBudgetTokens,
                signal: runnableConfig.signal,
                mode: "automatic",
                tracker: compressionTracker,
            });
        } catch (error) {
            // 自动压缩失败不能打断正常对话；用户主动停止除外，AbortSignal 仍需继续向上抛出。
            if (runnableConfig.signal?.aborted) throw error;
            console.warn("[langgraph-agent] 自动压缩上下文失败，回退到完整轮次裁剪:", error);
        }
        const summaryMessage = renderContextSummary(compression.memory.summary);
        const rawMessageBudget = Math.max(0, historyBudgetTokens - estimateTokens(summaryMessage));
        const contextMessages = fitMessagesToContext(activeContextMessages(state.messages, compression.memory), rawMessageBudget);
        let response: AIMessageChunk | undefined;
        const stream = await modelWithTools.stream(
            [new SystemMessage(systemPrompt), ...(summaryMessage ? [new SystemMessage(summaryMessage)] : []), ...contextMessages],
            runnableConfig,
        );
        for await (const chunk of stream) {
            response = response ? response.concat(chunk) : chunk;
        }
        if (!response) {
            throw new Error("模型没有返回任何内容。");
        }
        return {
            messages: [response],
            llmCalls: 1 + compression.modelCalls,
            ...(compression.compressed
                ? {
                      contextSummary: compression.memory.summary,
                      summarizedMessageCount: compression.memory.summarizedMessageCount,
                  }
                : {}),
            // usage_metadata 是网关对本次完整输入的真实计数；缺失时不覆盖线程上一次有效值。
            ...(response.usage_metadata?.input_tokens === undefined ? {} : { lastInputTokens: response.usage_metadata.input_tokens }),
        };
    };
}

/**
 * 上下文必须以完整用户轮次裁剪，不能只从数组尾部按单条消息截断。
 * 否则可能留下孤立 ToolMessage，OpenAI 兼容接口会因缺少对应 tool_call 而拒绝请求。
 */
function fitMessagesToContext(messages: BaseMessage[], budgetTokens: number): BaseMessage[] {
    if (messages.length === 0) return [];
    const turns: BaseMessage[][] = [];
    for (const message of messages) {
        if (HumanMessage.isInstance(message) || turns.length === 0) turns.push([]);
        turns.at(-1)!.push(message);
    }

    const selected: BaseMessage[][] = [];
    let usedTokens = 0;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turnTokens = estimateTokens(serializeConversationMessages(turns[index]));
        // 最新一轮始终保留；更早轮次只有在完整放得下时才加入。
        if (selected.length > 0 && usedTokens + turnTokens > budgetTokens) break;
        selected.unshift(turns[index]);
        usedTokens += turnTokens;
    }
    return selected.flat();
}

/**
 * 执行上一轮 AIMessage 里的 tool_calls。
 * 官方也提供 ToolNode，这里手写是为了把 ReAct 循环拆清楚，后续接 SSH 工具时更好加日志和权限控制。
 */
export function createToolNode(tools: StructuredToolInterface[]): GraphNode<typeof AgentState> {
    const toolsByName = Object.fromEntries(tools.map((item) => [item.name, item]));
    return async (state, runnableConfig) => {
        const lastMessage = state.messages.at(-1);
        if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
            return { messages: [] };
        }
        const result = [];
        for (const toolCall of lastMessage.tool_calls ?? []) {
            const currentTool = toolsByName[toolCall.name];
            if (!currentTool) {
                // 未知工具也要回 ToolMessage，否则模型下一轮会对不上 tool_call_id
                result.push(
                    new ToolMessage({
                        content: `未知工具: ${toolCall.name}`,
                        tool_call_id: toolCall.id ?? "",
                    }),
                );
                continue;
            }
            // 把本轮 RunnableConfig 继续传给工具，stop() 的 AbortSignal 才能到达命令执行层。
            result.push(await currentTool.invoke(toolCall, runnableConfig));
        }
        return { messages: result };
    };
}

/** 有 tool_calls 就进 toolNode，否则结束本轮 */
export const shouldContinue: ConditionalEdgeRouter<{ InputSchema: typeof AgentState; Nodes: "toolNode" }> = (state) => {
    const lastMessage = state.messages.at(-1);
    if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
        return END;
    }
    if (lastMessage.tool_calls?.length) {
        return "toolNode";
    }
    return END;
};
