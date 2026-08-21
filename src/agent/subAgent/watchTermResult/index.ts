import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import TermServer from "@/components/ssh/term_server";
import type { ModelConfigManager } from "../../config/manager";
import { reasoningInstruction } from "../../context";
import { collectChatModelResponse } from "../../model/factory";
import { TERMINAL_WATCH_SYSTEM_PROMPT } from "./prompt";

/** 写入 PTY 后先空一拍，等第一批输出进 xterm。 */
export const TERMINAL_WATCH_SETTLE_MS = 500;
/** 子 Agent 判定未结束时，外层再次询问的间隔。 */
export const TERMINAL_WATCH_POLL_MS = 1_000;
/** 送给模型的快照字符上限，避免单次上下文被大日志撑爆。返回给主 Agent 的仍是完整增量。 */
const MAX_JUDGE_CHARS = 24_000;

export interface TerminalWatchInput {
    snapshot: string;
    command: string;
    /** 监听描述：什么情况下可以结束观察。 */
    watchDescription: string;
}

/**
 * 单次观察：把当前终端增量交给模型判断是否结束。
 * 未结束返回空字符串，结束返回 lineIndex 到行尾的原始内容。
 * 不走 ReAct、不挂工具，因此每次上下文只有这一帧快照。
 */
export async function runTerminalWatchAgent(
    modelManager: ModelConfigManager,
    input: TerminalWatchInput,
    signal?: AbortSignal,
): Promise<string> {
    try {
        signal?.throwIfAborted();
        const model = modelManager.getChatModel();
        // 不能用 invoke()：streaming 模型拼完 SSE 后会去拉 tiktoken.pages.dev，国内会一直卡住。
        const response = await collectChatModelResponse(
            model,
            [
                new SystemMessage(`${TERMINAL_WATCH_SYSTEM_PROMPT}\n\n${reasoningInstruction("low")}`),
                new HumanMessage(
                    [
                        `写入内容: ${input.command}`,
                        `监听描述: ${input.watchDescription || "（未提供，按命令形态判断是否结束）"}`,
                        `当前终端增量（从 lineIndex 到末尾）：`,
                        capText(input.snapshot || "（还没有新输出）"),
                    ].join("\n"),
                ),
            ],
            signal,
        );
        const result = messageText(response);
        if (!isWatchDone(result)) return "";
        return input.snapshot || "终端没有返回内容。";
    } catch (e) {
        // 停止信号必须继续向上传递，否则外层会把取消误当成一次普通判断失败并继续轮询。
        signal?.throwIfAborted();
        console.error("判断终端是否结束失败:", e);
        // 单次判断失败不当成结束，外层会继续轮询或超时交出快照。
        return "";
    }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener("abort", aborted);
            resolve();
        }
        function aborted() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", aborted);
            reject(signal?.reason ?? new DOMException("操作已取消", "AbortError"));
        }
        signal?.addEventListener("abort", aborted, { once: true });
    });
}

/** 只认首行 DONE，其它一律视为还要继续等。 */
function isWatchDone(text: string): boolean {
    const first = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    return first.toUpperCase().startsWith("DONE");
}

function messageText(message: BaseMessage): string {
    if (AIMessage.isInstance(message) || typeof message.content === "string") {
        return typeof message.content === "string" ? message.content : message.text;
    }
    return message.text;
}

function capText(text: string): string {
    if (text.length <= MAX_JUDGE_CHARS) return text;
    const half = Math.floor(MAX_JUDGE_CHARS / 2);
    const omitted = text.length - MAX_JUDGE_CHARS;
    return `${text.slice(0, half)}\n\n...[中间省略 ${omitted} 字符]...\n\n${text.slice(-half)}`;
}
