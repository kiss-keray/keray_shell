import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

/**
 * Agent 图状态。
 * - messages：对话历史，MessagesValue 自带按 id 追加/更新的 reducer
 * - llmCalls：累计模型调用次数，方便观察 ReAct 循环轮数
 */
export const AgentState = new StateSchema({
    messages: MessagesValue,
    llmCalls: new ReducedValue(z.number().default(0), {
        reducer: (current: number, next: number) => current + next,
    }),
    /** 最近一次模型调用的真实输入 token；普通 Zod 字段使用 LastValue 语义，不做累计。 */
    lastInputTokens: z.number().int().nonnegative().optional(),
    /** 已压缩的滚动摘要；只进入模型上下文，不会作为普通消息显示在 UI。 */
    contextSummary: z.string().default(""),
    /** messages 前缀中已有多少条被滚动摘要覆盖，用于后续只做增量压缩。 */
    summarizedMessageCount: z.number().int().nonnegative().default(0),
});

export type AgentStateType = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
