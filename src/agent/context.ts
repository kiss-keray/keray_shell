import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { MIN_CONTEXT_WINDOW_TOKENS, type ModelConfig } from "./config/schema";
import { type AgentAccessMode, type AgentCommandExecution } from "./runtimeContext";

/** Agent 输入区支持的推理深度，值与 OpenAI 兼容接口的 reasoning effort 保持一致。 */
export type AgentReasoningEffort = ModelConfig["reasoningEffort"];

export type AgentContextCategory = "system" | "tools" | "rules" | "skills" | "mcp" | "subagents" | "conversation";

export interface AgentContextSegment {
    key: AgentContextCategory;
    label: string;
    tokens: number;
}

export interface AgentContextUsage {
    segments: AgentContextSegment[];
}

export interface ComputeContextUsageInput {
    systemPromptBody: string;
    skillCatalog: string;
    tools: StructuredToolInterface[];
    conversationText?: string;
    contextWindowTokens: number;
    reasoningEffort: AgentReasoningEffort;
    servers: ChannelInstance[];
    commandExecution: AgentCommandExecution;
    accessMode: AgentAccessMode;
}

export interface AgentSystemPromptParts {
    /** default.md 展开后的主体，其中已经包含核心规则。 */
    system: string;
    /** 动态技能目录，实际会拼进 SystemMessage。 */
    skills: string;
    /** 推理深度兼容提示。 */
    reasoning: string;
    /** 当前服务器列表等每轮变化的运行时信息。 */
    runtime: string;
    /** 访问模式和命令执行方式。 */
    rules: string;
}

const CONTEXT_SEGMENT_META: { key: AgentContextCategory; label: string }[] = [
    { key: "system", label: "系统提示词（含核心规则）" },
    { key: "tools", label: "工具定义" },
    { key: "rules", label: "规则" },
    { key: "skills", label: "技能" },
    { key: "mcp", label: "运行时上下文" },
    { key: "subagents", label: "子代理定义" },
    { key: "conversation", label: "对话" },
];

/** 初始化完成前给输入区一个结构完整的空用量，避免面板先渲染成空白列表。 */
export const EMPTY_CONTEXT_USAGE: AgentContextUsage = {
    segments: CONTEXT_SEGMENT_META.map((item) => ({ ...item, tokens: 0 })),
};

/**
 * 发送前的保守估算器，供界面预览和历史裁剪共用。
 *
 * DeepSeek / OpenAI 兼容网关没有统一的前置计数接口，因此这里按文本类型估算：
 * - ASCII、英文和代码平均约 4 字符/token；
 * - 中日韩字符按 1 字符/token，避免旧的统一除以 4 严重低估中文；
 * - 其它非 ASCII 字符按 2 个 ASCII 单位折算；
 * 最后保留 10% 协议余量。真实值仍以模型返回的 usage_metadata 为准。
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    let asciiUnits = 0;
    let cjkTokens = 0;
    for (const char of text) {
        if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) {
            cjkTokens += 1;
        } else {
            asciiUnits += char.codePointAt(0)! <= 0x7f ? 1 : 2;
        }
    }
    return Math.ceil((asciiUnits / 4 + cjkTokens) * 1.1);
}

/** 统一生成对模型可见的推理深度提示，兼容不识别 reasoningEffort 参数的第三方网关。 */
export function reasoningInstruction(effort: AgentReasoningEffort): string {
    const descriptions = {
        low: "优先快速直接地回答，只分析完成任务必需的关键步骤。",
        medium: "在速度与可靠性之间保持平衡，检查关键假设后再回答。",
        high: "充分拆解复杂问题，验证关键假设和结果后再回答。",
    } as const;
    return `## 当前推理深度\n\n${descriptions[effort]}`;
}

/** 序列化服务器列表，交给大模型 */
export function serializeServers(servers: ChannelInstance[]): string {
    const serverList = servers.map((item) => ({
        name: item.server.name,
        sessionId: item.sessionId,
        serverId: item.server.id,
    }));
    return `## 当前服务器列表，注意服务器当前信息必须以当前传的为准，历史记录里的不可信！\n\n${JSON.stringify(serverList)}`;
}

/**
 * 访问模式提示词
 * 访问限制与 agents/docs/safety-and-authorization.md 的风险分级对齐：
 * - ask：R1 询问（自动 R0，R1/R2/R3 都问）
 * - safe：R2 询问（自动 R0/R1，R2/R3 都问）
 * - auto：高度自主 / R3 询问（自动 R0/R1/R2，只问 R3）
 * - full：完全访问（自动执行 R1/R2/R3）
 * R4 禁止项在任何模式下都不可执行。
 */
export function accessModeInstruction(accessMode: AgentAccessMode): string {
    const descriptions = {
        ask: "访问模式为ask，R0自动执行，不需要询问。R1,R2,R3都要询问，R4不可执行。",
        safe: "访问模式为safe，R0,R1自动执行，不需要询问。R2,R3都要询问，R4不可执行。",
        auto: "访问模式为auto，R0,R1,R2自动执行，不需要询问。R3要询问，R4不可执行。",
        full: "访问模式为full，R0,R1,R2,R3自动执行，不需要询问。R4不可执行。",
    } as const;
    return `## 访问模式改为\n\n${descriptions[accessMode]}`;
}

/**
 * 命令执行方式提示词
 */
export function commandExecutionInstruction(commandExecution: AgentCommandExecution): string {
    const descriptions = {
        silent: "命令执行方式为silent，静默执行，不写入用户终端。",
        visual: "命令执行方式为visual，可视化终端执行，用户能看见执行过程。",
    } as const;
    return `## 命令执行方式改为\n\n${descriptions[commandExecution]}`;
}

/**
 * 构造主 Agent 每轮实际使用的系统提示片段。
 * 图节点发送和上下文面板统计必须共用本函数，避免运行时规则只发送却不计数。
 */
export function buildAgentSystemPromptParts(
    input: Omit<ComputeContextUsageInput, "tools" | "conversationText" | "contextWindowTokens" | "actualInputTokens">,
): AgentSystemPromptParts {
    return {
        system: input.systemPromptBody,
        skills: input.skillCatalog,
        reasoning: reasoningInstruction(input.reasoningEffort),
        runtime: serializeServers(input.servers),
        rules: [commandExecutionInstruction(input.commandExecution), accessModeInstruction(input.accessMode)].join("\n\n"),
    };
}

/** 按模型实际接收的顺序拼接系统提示，过滤空技能目录。 */
export function joinAgentSystemPrompt(parts: AgentSystemPromptParts): string {
    return [parts.system, parts.skills, parts.reasoning, parts.runtime, parts.rules].filter(Boolean).join("\n\n");
}

/** 把 LangChain 工具转换成 bindTools 实际使用的 OpenAI function schema。 */
export function serializeTools(tools: StructuredToolInterface[]): string {
    return JSON.stringify(tools.map((item) => convertToOpenAITool(item)));
}

/**
 * 把 LangGraph 中真实保留的消息压成稳定 JSON，界面估算和裁剪都使用同一口径。
 * 只保留会再次发给模型的字段，不把 UI 的 timeline/status 等展示状态算进上下文。
 */
export function serializeConversationMessages(messages: BaseMessage[]): string {
    return JSON.stringify(
        messages.map((message) => ({
            type: message.type,
            content: message.content,
            toolCalls: AIMessage.isInstance(message) ? message.tool_calls : undefined,
            toolCallId: ToolMessage.isInstance(message) ? message.tool_call_id : undefined,
        })),
    );
}

/** 把尚未提交的输入框草稿估成与已提交 HumanMessage 相同的 JSON 形态，便于和 conversation 分段相加。 */
export function estimateDraftConversationTokens(draft: string): number {
    if (!draft) return 0;
    return estimateTokens(JSON.stringify([{ type: "human", content: draft }]));
}

/**
 * 按输入区七个分类汇总当前会送进模型的上下文。
 * 子代理使用独立模型调用，不占主 Agent 上下文，因此该分类保持为 0。
 */
export function computeContextUsage(input: ComputeContextUsageInput): AgentContextUsage {
    const parts = buildAgentSystemPromptParts(input);
    const tokens: Record<AgentContextCategory, number> = {
        system: estimateTokens([parts.system, parts.reasoning].filter(Boolean).join("\n\n")),
        tools: estimateTokens(serializeTools(input.tools)),
        rules: estimateTokens(parts.rules),
        skills: estimateTokens(parts.skills),
        mcp: estimateTokens(parts.runtime),
        subagents: 0,
        conversation: estimateTokens(input.conversationText ?? ""),
    };
    return {
        segments: CONTEXT_SEGMENT_META.map((item) => ({ ...item, tokens: tokens[item.key] })),
    };
}
