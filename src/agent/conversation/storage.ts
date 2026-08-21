import md5 from "md5";
import { ensureConversationTempCopy, hydrateConversationPreviews, removeConversationTempFiles } from "./attachments";
import { type AgentMessageRole, type AgentAttachment, type AgentTimelineItem, type AgentToolStep } from "../types";
import type { UsageMetadata } from "@langchain/core/messages";
import type { AgentCompressionStatus, AgentContextMemory } from "../contextCompression";

const CONVERSATION_ROOT = "conversation";
const OPEN_STATE_FILE = "open.json";
/** 超过 30 天未活动的会话在加载该 projectId 时删除。 */
export const CONVERSATION_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

interface AgentChatMessageBase {
    id: string;
    role: AgentMessageRole;
    content: string;
}

// Agent基础对话，输入对话直接输入
export interface AgentInputMessage extends AgentChatMessageBase {
    skillNames?: string[];
    /** 用户本轮附带的本地文件/粘贴图片，助手消息不会有这个字段。 */
    attachments?: AgentAttachment[];
}

// Agent响应对话，需要保存思考和工具等信息
export interface AgentResponseMessage extends AgentChatMessageBase {
    reasoning: string;
    statusLines: string[];
    tools: AgentToolStep[];
    /** 思考与工具的交错顺序；旧会话可能缺省，渲染时用 resolveAgentTimeline 兜底。 */
    timeline?: AgentTimelineItem[];
    error?: string;
    /** 是否正在流式输出。 只影响UI */
    streaming: boolean;
    usageMetadata?: UsageMetadata;
}

// Agent系统提示，只用于界面展示（如模型切换提醒），不进入模型上下文
export interface AgentNoticeMessage extends AgentChatMessageBase {
    role: "system";
    /** 提示种类；目前只有模型切换，新增种类时渲染处按此字段分支。 */
    notice: "model-switch";
    /** 切换后的模型显示名。 */
    model: string;
}

export interface AgentCompressionMessage extends AgentChatMessageBase {
    role: "system";
    /** 压缩运行状态只用于当前 UI 时间线，不会送入模型上下文。 */
    notice: "compression";
    status: AgentCompressionStatus;
}

export type AgentChatMessage = AgentInputMessage | AgentResponseMessage | AgentNoticeMessage | AgentCompressionMessage;

/**
 * 按 projectId 持久化的 Agent 会话。
 * id 同时作为 LangGraph threadId，切回同一会话时模型侧记忆和 UI 消息才能对上。
 */
export interface AgentConversationRecord {
    id: string;
    /** 服务器 id 排序拼接后的分组键，与目录 md5 对应。 */
    projectId: string;
    /** 标签/历史列表标题，取首条用户消息截断。 */
    title: string;
    createdAt: number;
    /** 最后一次查看或发消息的时间戳，超过 30 天未更新的会话会在加载时删除。 */
    lastActiveAt: number;
    messages: AgentChatMessage[];
    /** 模型侧滚动摘要元数据；完整 UI 对话仍由 messages 保存。 */
    contextMemory?: AgentContextMemory;
}

/** 某个 projectId 下次打开时要恢复哪些标签、激活哪一条。 */
export interface AgentConversationOpenState {
    ids: string[];
    openIds: string[];
    activeId: string;
}

/** projectId 可能含逗号等字符，目录名用 md5 避免路径非法。 */
export function conversationProjectKey(projectId: string): string {
    return md5(projectId || "default");
}

function sessionFile(id: string): string {
    return `${id}.json`;
}

/** 落盘时去掉流式中间态，并把附件拷进 conversation/temp，JSON 里只记副本路径。 */
async function persistableMessages(messages: AgentChatMessage[]): Promise<AgentChatMessage[]> {
    return await Promise.all(
        messages
            .filter((message) => message.role !== "system")
            .map(async (message) => {
                if (message.role === "assistant") {
                    const msg = message as AgentResponseMessage;
                    return {
                        ...msg,
                        streaming: undefined,
                        // preparing/running 都是流式中间态；落盘时收口，避免重开会话后继续显示转圈。
                        tools: msg.tools.map((tool) =>
                            tool.state === "preparing" || tool.state === "running" ? { ...tool, state: "completed" as const } : tool,
                        ),
                        timeline: msg.timeline?.map((item) => ({ ...item })),
                    };
                }
                const msg = message as AgentInputMessage;
                return {
                    ...msg,
                    attachments: msg.attachments
                        ? await Promise.all(
                              msg.attachments.map(async (file) => {
                                  const stored = await ensureConversationTempCopy(file);
                                  return {
                                      name: stored.name,
                                      path: stored.path,
                                      size: stored.size,
                                      kind: stored.kind,
                                      mimeType: stored.mimeType,
                                  };
                              }),
                          )
                        : undefined,
                };
            }),
    );
}

function isRecord(value: unknown): value is AgentConversationRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as AgentConversationRecord;
    return typeof record.id === "string" && Array.isArray(record.messages);
}

/**
 * 会话文件落在 ~/.cache/keray_shell/conversation/{projectKey}/。
 * 每个会话一份 JSON，open.json 记录当前打开的标签。
 */
export function useConversationStorage() {
    const localStore = useLocalStore();

    /** 拼出 cache/conversation/{md5(projectId)}/ 下的相对路径段。 */
    function projectSegments(projectId: string, ...rest: string[]): string[] {
        return [CONVERSATION_ROOT, conversationProjectKey(projectId), ...rest];
    }

    /** 列出该项目未过期会话，同时删掉 30 天未活跃的文件。 */
    async function list(projectId: string): Promise<AgentConversationRecord[]> {
        await localStore.ensureCacheDir(...projectSegments(projectId));
        const names = await localStore.listCacheFiles(...projectSegments(projectId));
        const records: AgentConversationRecord[] = [];
        const expireBefore = Date.now() - CONVERSATION_MAX_IDLE_MS;
        for (const name of names) {
            if (name === OPEN_STATE_FILE || !name.endsWith(".json")) continue;
            const record = await localStore.readCacheFile<AgentConversationRecord>(...projectSegments(projectId, name));
            if (!isRecord(record)) continue;
            // 仅清理长期不活跃的历史；正在看的会话会在打开时刷新 lastActiveAt。
            if (record.lastActiveAt < expireBefore) {
                await removeConversationTempFiles(record.messages);
                await localStore.removeCacheFile(...projectSegments(projectId, name));
                continue;
            }
            // JSON 不存 blob: 预览；读盘后按附件副本路径再生成一次。
            await hydrateConversationPreviews(record.messages);
            records.push(record);
        }
        return records.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    }

    /** 读取单条会话；文件损坏或格式不对时当作不存在。 */
    async function read(projectId: string, id: string): Promise<AgentConversationRecord | undefined> {
        const record = await localStore.readCacheFile<AgentConversationRecord>(...projectSegments(projectId, sessionFile(id)));
        if (!isRecord(record)) return undefined;
        await hydrateConversationPreviews(record.messages);
        return record;
    }

    /** 覆盖写入会话正文；空会话由调用方决定不写，避免历史列表被空白标签占满。 */
    async function write(record: AgentConversationRecord): Promise<void> {
        // 按字段显式组装，丢掉旧文件里残留的 input 草稿，输入框已不再跟会话绑定。
        const payload: AgentConversationRecord = {
            id: record.id,
            projectId: record.projectId,
            title: record.title,
            createdAt: record.createdAt,
            lastActiveAt: record.lastActiveAt,
            messages: await persistableMessages(record.messages),
            contextMemory: record.contextMemory,
        };
        await localStore.writeCacheFile(projectSegments(record.projectId, sessionFile(record.id)), payload);
    }

    /** 删除单条会话文件，并清掉该记录引用的 conversation/temp 附件副本。 */
    async function remove(projectId: string, id: string): Promise<void> {
        // 走原始 JSON，不为即将删除的附件再造一遍 blob 预览。
        const record = await localStore.readCacheFile<AgentConversationRecord>(...projectSegments(projectId, sessionFile(id)));
        if (isRecord(record)) await removeConversationTempFiles(record.messages);
        await localStore.removeCacheFile(...projectSegments(projectId, sessionFile(id)));
    }

    /** 读取上次打开的标签集合；文件缺失时由调用方按空标签启动。 */
    async function readOpenState(projectId: string): Promise<AgentConversationOpenState | undefined> {
        return await localStore.readCacheFile<AgentConversationOpenState>(...projectSegments(projectId, OPEN_STATE_FILE));
    }

    /** 只存打开中的标签 id，历史正文仍在各会话 JSON 里。 */
    async function writeOpenState(projectId: string, state: AgentConversationOpenState): Promise<void> {
        await localStore.writeCacheFile(projectSegments(projectId, OPEN_STATE_FILE), state);
    }

    return { list, read, write, remove, readOpenState, writeOpenState };
}
