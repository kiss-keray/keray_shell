import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { buildAgentInput } from "../input";
import { type AgentChatMessage, resolveAgentTimeline, type AgentToolStep, type AgentResponseMessage, type AgentInputMessage } from "../types";

/**
 * 把落盘的 UI 会话还原成 LangGraph 消息。
 *
 * 界面 JSON 只保证能渲染气泡；真正发给模型的上下文在 MemorySaver 里，进程重启后是空的。
 * 这里按「用户轮次 + 工具调用/结果 + 最终回复」重建，下一轮 llmCall 才能看见历史。
 * 多轮 ReAct 按时间线里连续的 tool 项合并成一次并行 tool_calls，避免拆成缺少配对的 ToolMessage。
 */
export async function uiMessagesToGraphMessages(messages: AgentChatMessage[]): Promise<BaseMessage[]> {
    const result: BaseMessage[] = [];
    for (const message of messages) {
        // 系统提示（如模型切换提醒）只是界面展示，不能还原进模型上下文。
        if (message.role === "system") continue;
        if (message.role === "user") {
            result.push(await toHumanGraphMessage(message));
            continue;
        }
        const restored = toAssistantGraphMessages(message);
        if (restored.length > 0) result.push(...restored);
    }
    return result;
}

/** 用户气泡只存了原文和附件路径；还原时再走一遍发送组装，图片/文件才能回到 HumanMessage。 */
async function toHumanGraphMessage(message: AgentChatMessage): Promise<HumanMessage> {
    const input = await buildAgentInput(message);
    return new HumanMessage({ content: input, id: message.id });
}

/**
 * 助手气泡把整轮工具和最终正文压在一条 UI 消息里。
 * 还原时拆回 AIMessage(tool_calls) → ToolMessage* → 最终 AIMessage，OpenAI 兼容接口才收得下。
 */
function toAssistantGraphMessages(message: AgentChatMessage): BaseMessage[] {
    const inputMessage = message as AgentInputMessage;
    const responseMessage = message as AgentResponseMessage;
    const isResponseMessage = message.role === "assistant";
    if (isResponseMessage && responseMessage.streaming) return [];
    const rounds = isResponseMessage ? toolRoundsFromMessage(responseMessage) : [];
    const result: BaseMessage[] = [];
    for (const round of rounds) {
        result.push(
            new AIMessage({
                content: "",
                tool_calls: round.map(toToolCall),
            }),
        );
        for (const tool of round) {
            result.push(
                new ToolMessage({
                    content: toToolContent(tool.output),
                    tool_call_id: tool.id,
                    name: tool.name,
                }),
            );
        }
    }
    const finalText = message.content.trim() || responseMessage.error?.trim() || "";
    // 有工具也要补一条无 tool_calls 的收尾，检查点才像一轮已经结束，而不是停在等工具结果。
    if (finalText || rounds.length > 0) {
        result.push(new AIMessage({ content: finalText, id: message.id }));
    }
    return result;
}

/** 时间线里被推理块隔开的工具视为不同 ReAct 轮次；连续 tool 视为同一次并行调用。 */
function toolRoundsFromMessage(message: AgentResponseMessage): AgentToolStep[][] {
    const toolsById = new Map(message.tools.map((tool) => [tool.id, tool]));
    const rounds: AgentToolStep[][] = [];
    let current: AgentToolStep[] = [];
    for (const item of resolveAgentTimeline(message)) {
        if (item.type !== "tool") {
            if (current.length > 0) {
                rounds.push(current);
                current = [];
            }
            continue;
        }
        const tool = toolsById.get(item.id);
        if (tool) current.push(tool);
    }
    if (current.length > 0) rounds.push(current);
    // 旧记录可能没有 timeline，或个别工具没写进时间线；漏掉的补成最后一轮，避免丢掉 load_skill 正文。
    const seen = new Set(rounds.flat().map((tool) => tool.id));
    const leftover = message.tools.filter((tool) => !seen.has(tool.id));
    if (leftover.length > 0) rounds.push(leftover);
    return rounds;
}

function toToolCall(tool: AgentToolStep) {
    return {
        id: tool.id,
        name: tool.name,
        args: toToolArgs(tool.input),
        type: "tool_call" as const,
    };
}

function toToolArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
    return { input };
}

function toToolContent(output: unknown): string {
    if (typeof output === "string") return output;
    if (output === undefined) return "";
    try {
        return JSON.stringify(output);
    } catch {
        return String(output);
    }
}
