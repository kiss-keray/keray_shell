import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage,
    type UsageMetadata,
    type BaseMessage,
    type MessageContent,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ModelConfigManager, type ModelConfigListener, type ModelSelectListener, type ModelConfigManagerOptions } from "./config/manager";
import type { ModelConfig, ModelsConfig } from "./config/schema";
import { estimateTokens, type AgentReasoningEffort } from "./context";
import {
    compressConversationContext,
    ContextCompressionTracker,
    normalizeContextMemory,
    serializeCompressedConversation,
    type AgentCompressionListener,
    type AgentCompressionState,
    type AgentContextMemory,
    type ContextCompressionResult,
} from "./contextCompression";
import { compileAgentGraph, type CompiledAgentGraph } from "./graph/graph";
import type { AgentStateType } from "./graph/state";
import { createBuiltinTools, type ToolOptions } from "./graph/tools";
import { PromptManager, type PromptManagerOptions, type PromptReloadListener } from "./prompt/manager";

export interface CreateLangGraphAgentOptions extends ModelConfigManagerOptions, PromptManagerOptions, ToolOptions {
    /** 是否监听模型配置和提示词/技能文档热重载，默认 true */
    watch?: boolean;
}

export interface AgentInvokeOptions {
    /** 会话线程。相同 threadId 会走 checkpointer 保留多轮记忆 */
    threadId?: string;
    /**
     * 检查点为空时由 stream 一并写入的历史消息。
     * restoreThreadIfEmpty 失败时仍能把 UI 记录带进本轮 llmCall，避免只发新输入。
     */
    priorMessages?: BaseMessage[];
    /** 外部停止信号；abort 后会中断底层模型 HTTP 流，图执行随之结束。 */
    signal?: AbortSignal;
}

/**
 * 提供给前端的稳定流事件协议。
 *
 * LangGraph 的原始 stream chunk 会随 streamMode 呈现不同结构，UI 不应该直接
 * 依赖这些内部结构；在门面层归一化后，消息、推理摘要和工具状态才能独立渲染。
 */
export type AgentStreamEvent =
    | { type: "status"; text: string }
    | { type: "text-delta"; text: string }
    | { type: "reasoning-delta"; text: string }
    | { type: "tool-prepare"; id: string; name: string }
    | { type: "tool-start"; id: string; pendingId?: string; name: string; input: unknown }
    | { type: "tool-result"; id: string; output: unknown }
    | { type: "usage"; data?: UsageMetadata };

/** 模型流里尚未拼完的工具调用；只跟踪标识和名称，不把长参数增量写进 Vue。 */
interface StreamingToolCallDraft {
    idParts: string;
    nameParts: string;
    uiId?: string;
    announced: boolean;
}

export interface GraphConfigurable {
    servers: ChannelInstance[];
    thread_id: string;
}

/**
 * LangGraph Agent 门面。
 * 提示词来自 agents/builtin/default.md，技能来自 builtin/skills，模型配置来自 ~/.cache/keray_shell/model.json。
 */
export class LangGraphAgent {
    readonly modelManager: ModelConfigManager;
    readonly promptManager: PromptManager;
    readonly tools: StructuredToolInterface[];
    private readonly graph: CompiledAgentGraph;
    private readonly servers: ChannelInstance[];
    /** 图内自动压缩和公开手动入口共用同一个状态发布器。 */
    private readonly compressionTracker: ContextCompressionTracker;
    /** 同一 thread 并发 restore 共用一个 Promise，避免两次 updateState 把历史追加两遍。 */
    private readonly threadRestoreTasks = new Map<string, Promise<boolean>>();
    /** 同一 thread 的手动压缩串行执行，避免两个摘要结果互相覆盖。 */
    private readonly threadCompressionTasks = new Map<string, Promise<ContextCompressionResult>>();

    private constructor(
        modelManager: ModelConfigManager,
        promptManager: PromptManager,
        tools: StructuredToolInterface[],
        graph: CompiledAgentGraph,
        servers: ChannelInstance[],
        compressionTracker: ContextCompressionTracker,
    ) {
        this.modelManager = modelManager;
        this.promptManager = promptManager;
        this.tools = tools;
        this.graph = graph;
        this.servers = servers;
        this.compressionTracker = compressionTracker;
    }

    /**
     * 初始化过程需要读取 Tauri 文件系统，因此从 Node 迁移后改为异步工厂。
     * 调用方必须使用 `await LangGraphAgent.create()`，不能再直接 new。
     */
    static async create(options: CreateLangGraphAgentOptions = {}, servers: ChannelInstance[]): Promise<LangGraphAgent> {
        const { watch = true, debounceMs, agentsDir, promptPath } = options;
        const modelManager = await ModelConfigManager.create({ debounceMs });
        const promptManager = await PromptManager.create({ debounceMs, agentsDir, promptPath });
        // load_skill 始终挂上，否则 default.md 里的专题文档无法按需读取
        const tools = createBuiltinTools(promptManager, modelManager, options);
        const compressionTracker = new ContextCompressionTracker();
        const graph = compileAgentGraph(modelManager, promptManager, tools, servers, compressionTracker);
        if (watch) {
            try {
                // 两个监听互不依赖，并行启动可减少 Agent 首次初始化耗时。
                await Promise.all([modelManager.startWatch(), promptManager.startWatch()]);
            } catch (error) {
                // 任一监听启动失败时清理另一侧，避免 create 拒绝后遗留后台监听。
                modelManager.dispose();
                promptManager.dispose();
                throw error;
            }
        }
        return new LangGraphAgent(modelManager, promptManager, tools, graph, servers, compressionTracker);
    }

    getModelConfig(): ModelConfig {
        return this.modelManager.getConfig();
    }

    /** 返回设置页维护的全部可用模型；当前默认模型由 activeModelId 记录。 */
    getModelsConfig(): ModelsConfig {
        return this.modelManager.getModelsConfig();
    }

    getSelectedModelId(): string {
        return this.modelManager.getSelectedModelId();
    }

    /** 切换默认模型并保存到 model.json，下次启动继续使用。 */
    async selectModel(modelId: string, persist = true): Promise<boolean> {
        return await this.modelManager.selectModel(modelId, persist);
    }

    /** 保存当前模型的推理深度；llmCall 会把它写进模型参数和系统提示。 */
    async setReasoningEffort(value: AgentReasoningEffort, persist = true): Promise<ModelConfig> {
        return await this.modelManager.setReasoningEffort(value, persist);
    }

    /** 保存当前模型的上下文大小；llmCall 按该预算裁剪历史。 */
    async setContextWindowTokens(value: number, persist = true): Promise<ModelConfig> {
        return await this.modelManager.setContextWindowTokens(value, persist);
    }

    /**
     * 读取指定线程真实保留的 LangGraph 消息，供输入区估算下一次调用。
     * MemorySaver 中还没有该线程时返回空字符串；调用方应先 restoreThreadIfEmpty，再刷新用量。
     */
    async getThreadConversationText(threadId: string): Promise<string> {
        try {
            const snapshot = await this.graph.getState({ configurable: { thread_id: threadId } });
            const state = snapshot.values as Partial<AgentStateType>;
            const messages = state.messages ?? [];
            return serializeCompressedConversation(messages, {
                summary: state.contextSummary,
                summarizedMessageCount: state.summarizedMessageCount,
            });
        } catch {
            return "";
        }
    }

    /** 读取可随 UI 会话落盘的滚动摘要状态。 */
    async getThreadContextMemory(threadId: string): Promise<AgentContextMemory> {
        try {
            const snapshot = await this.graph.getState({ configurable: { thread_id: threadId } });
            const state = snapshot.values as Partial<AgentStateType>;
            return normalizeContextMemory(
                { summary: state.contextSummary, summarizedMessageCount: state.summarizedMessageCount },
                state.messages?.length ?? 0,
            );
        } catch {
            return { summary: "", summarizedMessageCount: 0 };
        }
    }

    /** 当前压缩状态的同步快照，初始化 UI 时不必等待下一次事件。 */
    getCompressionState(): AgentCompressionState {
        return this.compressionTracker.getState();
    }

    /** 自动和手动压缩都会走同一个订阅入口。 */
    onCompressionStateChange(listener: AgentCompressionListener): () => void {
        return this.compressionTracker.onChange(listener);
    }

    /**
     * 检查点为空时把 UI 历史写入 MemorySaver。
     * 图用内存 checkpointer，重载会话后必须先灌进去，stream 才不会只带上本轮新输入。
     * asNode 用 llmCall：最后一条应是无 tool_calls 的 AIMessage，状态看起来像一轮已经正常结束。
     */
    async restoreThreadIfEmpty(threadId: string, messages: BaseMessage[], contextMemory?: AgentContextMemory): Promise<boolean> {
        if (messages.length === 0) return false;
        const pending = this.threadRestoreTasks.get(threadId);
        if (pending) return pending;
        const task = this.writeThreadIfEmpty(threadId, messages, contextMemory);
        this.threadRestoreTasks.set(threadId, task);
        try {
            return await task;
        } finally {
            this.threadRestoreTasks.delete(threadId);
        }
    }

    private async writeThreadIfEmpty(threadId: string, messages: BaseMessage[], contextMemory?: AgentContextMemory): Promise<boolean> {
        const config: GraphConfigurable = { servers: this.servers, thread_id: threadId };
        try {
            const snapshot = await this.graph.getState({ configurable: config });
            const existing = (snapshot.values as Partial<AgentStateType>).messages ?? [];
            if (existing.length > 0) return false;
            const memory = normalizeContextMemory(contextMemory, messages.length);
            await this.graph.updateState(
                { configurable: config },
                {
                    messages,
                    contextSummary: memory.summary,
                    summarizedMessageCount: memory.summarizedMessageCount,
                },
                "llmCall",
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 供 UI 按钮调用的显式压缩入口。它只更新 LangGraph 的模型记忆，不删除完整聊天记录。
     * 自动压缩失败会静默降级，但用户主动压缩需要把错误抛给界面，便于明确反馈。
     */
    async compressContext(threadId: string, signal?: AbortSignal): Promise<ContextCompressionResult> {
        const pending = this.threadCompressionTasks.get(threadId);
        if (pending) return pending;
        const task = this.compressThreadContext(threadId, signal);
        this.threadCompressionTasks.set(threadId, task);
        try {
            return await task;
        } finally {
            this.threadCompressionTasks.delete(threadId);
        }
    }

    private async compressThreadContext(threadId: string, signal?: AbortSignal): Promise<ContextCompressionResult> {
        const configurable = { servers: this.servers, thread_id: threadId };
        this.compressionTracker.start("manual");
        try {
            const snapshot = await this.graph.getState({ configurable });
            const state = snapshot.values as Partial<AgentStateType>;
            const messages = state.messages ?? [];
            const result = await compressConversationContext({
                messages,
                memory: { summary: state.contextSummary, summarizedMessageCount: state.summarizedMessageCount },
                modelManager: this.modelManager,
                // force 模式压缩当前全部历史；窗口值用于切分过大的摘要输入批次。
                historyBudgetTokens: this.modelManager.getConfig().contextWindowTokens,
                force: true,
                signal,
                mode: "manual",
                tracker: this.compressionTracker,
            });
            if (result.compressed) {
                await this.graph.updateState(
                    { configurable },
                    {
                        contextSummary: result.memory.summary,
                        summarizedMessageCount: result.memory.summarizedMessageCount,
                    },
                    "llmCall",
                );
            }
            this.compressionTracker.complete("manual", result);
            return result;
        } catch (error) {
            // 摘要成功但检查点更新失败时覆盖先前 success，避免上层误报已持久化。
            this.compressionTracker.fail("manual", error);
            throw error;
        }
    }

    /**
     * 检查点已有消息时只追加本轮 HumanMessage。
     * 为空且带了 priorMessages 时把历史和新输入一起写入，兜底 updateState 失败。
     */
    private async nextStreamMessages(threadId: string, input: MessageContent, priorMessages?: BaseMessage[]): Promise<BaseMessage[]> {
        const human = toHumanMessage(input);
        if (!priorMessages?.length) return [human];
        try {
            const snapshot = await this.graph.getState({ configurable: { thread_id: threadId } });
            const existing = (snapshot.values as Partial<AgentStateType>).messages ?? [];
            if (existing.length > 0) return [human];
        } catch {
            // getState 失败时仍带上历史，总比只发本轮更接近用户预期。
        }
        return [...priorMessages, human];
    }

    /** 技能列表带估算 token，供输入区“添加技能”和用量预览使用。 */
    listSkillOptions(): { name: string; description: string; estimatedTokens: number }[] {
        return this.promptManager.listSkills().map((skill) => ({
            name: skill.name,
            description: skill.description,
            estimatedTokens: estimateTokens(skill.body),
        }));
    }

    getSystemPrompt(): string {
        return this.promptManager.getSystemPrompt();
    }

    /** 编程式热更新。persist 为 true 时写回配置文件 */
    async updateModelConfig(partial: Partial<ModelConfig>, persist = false): Promise<ModelConfig> {
        return await this.modelManager.updateConfig(partial, persist);
    }

    /** 手动从磁盘重载模型配置 */
    async reloadModelConfig(): Promise<boolean> {
        return await this.modelManager.reloadFromDisk();
    }

    /** 手动重载 default.md 与技能文档 */
    async reloadPrompts(): Promise<boolean> {
        return await this.promptManager.reload();
    }

    onModelReload(listener: ModelConfigListener): () => void {
        return this.modelManager.onReload(listener);
    }

    /** 订阅用户主动切换模型；UI 借此在对话时间线补提示，与配置热重载事件区分开。 */
    onModelSelect(listener: ModelSelectListener): () => void {
        return this.modelManager.onModelSelect(listener);
    }

    onPromptReload(listener: PromptReloadListener): () => void {
        return this.promptManager.onReload(listener);
    }

    async invoke(
        input: MessageContent,
        options: AgentInvokeOptions = {},
    ): Promise<{
        messages: BaseMessage[];
        llmCalls: number;
        text: string;
    }> {
        const result = await this.graph.invoke(
            { messages: [toHumanMessage(input)] },
            { configurable: { thread_id: options.threadId ?? "default" } },
        );
        return {
            messages: result.messages,
            llmCalls: result.llmCalls,
            text: lastAiText(result.messages),
        };
    }

    /**
     * 同时输出节点进度和模型 token，并转换为前端可直接消费的事件。
     * llmCall 走 ChatOpenAI.stream()（HTTP SSE）；这里的 streamMode.messages 把每个 token 转成 UI 增量事件。
     * updates 仍用于工具调用/节点状态。
     */
    async *stream(input: MessageContent, options: AgentInvokeOptions = {}): AsyncGenerator<AgentStreamEvent> {
        yield { type: "status", text: "正在理解你的请求" };
        const threadId = options.threadId ?? "default";
        const config = { configurable: { thread_id: threadId } };
        const incoming = await this.nextStreamMessages(threadId, input, options.priorMessages);
        const stream = await this.graph.stream(
            { messages: incoming },
            {
                streamMode: ["updates", "messages"],
                configurable: config.configurable,
                // RunnableConfig.signal：LangGraph 在每次节点/流迭代前检查，中断后底层 fetch 也会被取消。
                signal: options.signal,
            },
        );
        // llmCall 的 updates 要等参数完整后才到；先从 messages 的 tool_call_chunks 发布准备态。
        const pendingToolCalls = new Map<number, StreamingToolCallDraft>();
        // 多 streamMode 的返回值统一为 [mode, chunk]；此处集中隔离 LangGraph 的原始类型。
        for await (const rawChunk of stream as AsyncIterable<["updates" | "messages", unknown]>) {
            const [mode, chunk] = rawChunk;
            if (mode === "messages") {
                const [messageChunk, metadata] = chunk as [unknown, Record<string, unknown>];
                // toolNode 的 ToolMessage 只走下面的 tool-result；不能再当 text-delta，否则会进助手正文。
                if (isToolResultChunk(messageChunk, metadata)) continue;
                if (AIMessageChunk.isInstance(messageChunk)) {
                    for (const toolChunk of messageChunk.tool_call_chunks ?? []) {
                        const index = toolChunk.index ?? 0;
                        const draft = pendingToolCalls.get(index) ?? {
                            idParts: "",
                            nameParts: "",
                            announced: false,
                        };
                        draft.idParts += toolChunk.id ?? "";
                        draft.nameParts += toolChunk.name ?? "";
                        pendingToolCalls.set(index, draft);

                        // 等参数流真正开始时名称通常已完整；仅通知一次，参数本体仍在最终 tool-start 一次性下发。
                        if (!draft.announced && draft.nameParts && toolChunk.args !== undefined) {
                            draft.uiId = draft.idParts || `pending-tool-${crypto.randomUUID()}`;
                            draft.announced = true;
                            yield { type: "tool-prepare", id: draft.uiId, name: draft.nameParts };
                        }
                    }
                }
                const text = extractMessageText(messageChunk);
                const reasoning = extractReasoningText(messageChunk);
                if (reasoning) yield { type: "reasoning-delta", text: reasoning };
                if (text) yield { type: "text-delta", text };
                continue;
            }

            const updates = chunk as Record<string, { messages?: BaseMessage[]; lastInputTokens?: number }>;
            let usageMetadata: UsageMetadata | undefined;
            for (const [nodeName, update] of Object.entries(updates)) {
                if (nodeName === "llmCall") {
                    const aiMessage = findLastAiMessage(update.messages ?? []);
                    usageMetadata = usageMetadataAdd(usageMetadata, aiMessage?.usage_metadata);
                    const toolCalls = aiMessage?.tool_calls ?? [];
                    if (!toolCalls.length) {
                        pendingToolCalls.clear();
                        yield { type: "status", text: "回复生成完成" };
                        continue;
                    }
                    yield { type: "status", text: `准备执行 ${toolCalls.length} 个工具` };
                    for (const [index, toolCall] of toolCalls.entries()) {
                        const draft = pendingToolCalls.get(index);
                        const id = toolCall.id ?? draft?.uiId ?? `${toolCall.name}-${crypto.randomUUID()}`;
                        yield {
                            type: "tool-start",
                            id,
                            pendingId: draft?.announced ? draft.uiId : undefined,
                            name: toolCall.name,
                            input: toolCall.args,
                        };
                    }
                    // 下一轮 ReAct 的工具下标会从 0 重新开始，完整调用下发后必须清空本轮草稿。
                    pendingToolCalls.clear();
                } else if (nodeName === "toolNode") {
                    for (const message of update.messages ?? []) {
                        if (!ToolMessage.isInstance(message)) continue;
                        yield {
                            type: "tool-result",
                            id: message.tool_call_id,
                            output: normalizeMessageContent(message.content),
                        };
                    }
                    yield { type: "status", text: "工具执行完成，正在整理结果" };
                }
            }
            yield { type: "usage", data: usageMetadata };
        }
    }

    dispose(): void {
        this.modelManager.dispose();
        this.promptManager.dispose();
        this.compressionTracker.dispose();
    }
}

function lastAiText(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (AIMessage.isInstance(message) && !message.tool_calls?.length) {
            return typeof message.content === "string" ? message.content : message.text;
        }
    }
    const last = messages.at(-1);
    if (!last) return "";
    return typeof last.content === "string" ? last.content : last.text;
}

/** 兼容当前 ES target，避免依赖 ES2023 Array.findLast。 */
function findLastAiMessage(messages: BaseMessage[]): AIMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (AIMessage.isInstance(message)) return message;
    }
    return undefined;
}

/**
 * 判断这段 messages 流是否来自工具执行。
 * LangGraph 会把 ToolMessage 和 llm token 混在同一条 messages 流里，必须在这里挡掉，
 * 前端 content 才只剩模型对用户说的话。
 */
function isToolResultChunk(message: unknown, metadata?: Record<string, unknown>): boolean {
    if (metadata?.langgraph_node === "toolNode") return true;
    if (!message || typeof message !== "object") return false;
    if (ToolMessage.isInstance(message)) return true;
    const typed = message as { _getType?: () => string; type?: string };
    return typed._getType?.() === "tool" || typed.type === "tool";
}

/** 提取消息 token；兼容字符串内容和 OpenAI content block。 */
function extractMessageText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block): block is { type?: string; text: string } =>
            Boolean(
                block &&
                typeof block === "object" &&
                "text" in block &&
                typeof block.text === "string" &&
                (!block.type || block.type === "text"),
            ),
        )
        .map((block) => block.text)
        .join("");
}

/** 文本走字符串构造；图片走 content 数组，否则视觉模型收不到 image_url。 */
function toHumanMessage(input: MessageContent): HumanMessage {
    return typeof input === "string" ? new HumanMessage(input) : new HumanMessage({ content: input });
}

/**
 * 仅透传模型明确返回的 reasoning 字段，不推导或伪造隐藏思维链。
 * OpenAI 兼容服务常把该字段放在 additional_kwargs.reasoning_content 中。
 */
function extractReasoningText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const additional = (message as { additional_kwargs?: Record<string, unknown> }).additional_kwargs;
    const reasoning = additional?.reasoning_content;
    if (typeof reasoning === "string") return reasoning;

    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block): block is { type: string; text: string } =>
            Boolean(
                block &&
                typeof block === "object" &&
                "type" in block &&
                "text" in block &&
                (block.type === "reasoning" || block.type === "reasoning_content") &&
                typeof block.text === "string",
            ),
        )
        .map((block) => block.text)
        .join("");
}

/** 把工具结果收敛成可序列化内容，避免 Vue 直接渲染消息类实例。 */
function normalizeMessageContent(content: BaseMessage["content"]): unknown {
    if (typeof content === "string") {
        try {
            return JSON.parse(content) as unknown;
        } catch {
            return content;
        }
    }
    return content;
}

function usageMetadataAdd(a?: UsageMetadata, b?: UsageMetadata): UsageMetadata {
    function objAdd(a?: Record<string, unknown>, b?: Record<string, unknown>): Record<string, unknown> {
        if (!a || !b) return a || b || {};
        const ax = { ...a, ...b };
        return Object.entries(ax).reduce((acc: Record<string, unknown>, [key, value]) => {
            type nt = number | undefined | null;
            if (typeof value === "number") {
                acc[key] = ((value as nt) || 0) + ((b[key] as nt) ?? 0);
            } else if (typeof value === "object") {
                acc[key] = objAdd(value as Record<string, unknown>, b[key] as Record<string, unknown>);
            }
            return acc;
        }, {});
    }
    return objAdd(a, b) as UsageMetadata;
}
