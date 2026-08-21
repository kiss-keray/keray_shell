import { type AgentResponseMessage } from "./conversation/storage";

export type AgentMessageRole = "user" | "assistant" | "system";

export type AgentToolState = "preparing" | "running" | "completed" | "error" | "cancelled";

export interface AgentToolStep {
    id: string;
    name: string;
    input: unknown;
    output?: unknown;
    state: AgentToolState;
}

/**
 * 思考区时间线：按流事件发生顺序交错存放推理文本和工具调用。
 * 同一轮连续 reasoning-delta 会拼进同一块；工具打断后再来推理会新开一块。
 */
export type AgentTimelineItem = { type: "reasoning"; id: string; text: string } | { type: "tool"; id: string };

export interface AgentModelOption {
    id: string;
    model: string;
    /** 当前模型声明的上下文上限，用于限制输入区滑动条。 */
    maxContextWindowTokens: number;
}

export interface AgentSkillOption {
    name: string;
    description: string;
    /** 用于上下文面板的近似 token 数，不承诺与具体模型 tokenizer 完全一致。 */
    estimatedTokens: number;
}

/** 模型侧可直接作为 image_url 发送的图片类型；其它图片当普通二进制附件。 */
const AGENT_IMAGE_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
};

export interface AgentAttachment {
    name: string;
    path: string;
    size: number;
    /** 粘贴或选中的图片走视觉输入；未标注时按扩展名判断。 */
    kind?: "file" | "image";
    mimeType?: string;
    /** 仅内存预览：落盘时去掉，重新加载后按 path 再生成 blob: URL。 */
    previewUrl?: string;
}

/**
 * 旧会话没有 timeline 时，退回「整段思考 + 全部工具」，避免历史消息空白。
 * 新消息直接返回流式阶段按事件顺序写好的时间线。
 */
export function resolveAgentTimeline(message: AgentResponseMessage): AgentTimelineItem[] {
    if (message.timeline?.length) return message.timeline;
    const items: AgentTimelineItem[] = [];
    if (message.reasoning) items.push({ type: "reasoning", id: `${message.id}-reasoning`, text: message.reasoning });
    for (const tool of message.tools) items.push({ type: "tool", id: tool.id });
    return items;
}

export function mimeFromFileName(name: string): string | undefined {
    const ext = name.split(".").pop()?.toLowerCase();
    return ext ? AGENT_IMAGE_MIME[ext] : undefined;
}

/** 是否应按多模态图片发给模型，而不是当二进制文件只传路径。 */
export function isAgentImageAttachment(file: Pick<AgentAttachment, "name" | "kind" | "mimeType">): boolean {
    if (file.kind === "file") return false;
    if (file.kind === "image") return true;
    if (file.mimeType && Object.values(AGENT_IMAGE_MIME).includes(file.mimeType)) return true;
    return Boolean(mimeFromFileName(file.name));
}

export type {
    AgentInputMessage,
    AgentResponseMessage,
    AgentNoticeMessage,
    AgentCompressionMessage,
    AgentChatMessage,
    AgentConversationRecord,
    AgentConversationOpenState,
} from "./conversation/storage";

export type { AgentPromptSubmitOptions } from "./input";

export type { AgentStreamEvent, LangGraphAgent, AgentInvokeOptions } from "./agent";

export type { AgentContextCategory, AgentContextSegment, AgentContextUsage, AgentReasoningEffort } from "./context";

export type {
    AgentCompressionMode,
    AgentCompressionState,
    AgentCompressionStatus,
    AgentContextMemory,
    ContextCompressionResult,
} from "./contextCompression";

export type { CommandQueueItem, CommandQueueCall } from "./graph/tools";
