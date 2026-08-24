import { tool, type StructuredToolInterface, type ToolRunnableConfig } from "@langchain/core/tools";
import { z } from "zod";
import type { PromptManager } from "../prompt/manager";
import type { ModelConfigManager } from "../config/manager";
import { getAgentRuntimeContext } from "../runtimeContext";
import { runTerminalWatchAgent, sleep, TERMINAL_WATCH_SETTLE_MS } from "../subAgent/watchTermResult";
import TermServer from "@/components/ssh/term_server";
import { parseCommandResultIsSuccess } from "./utils/commandStatus";
import { parseCommandResultShouldStopWatching } from "./utils/commandFinished";
import { increasingSleep } from "./utils/Index";
import { cancelExecRemote, execRemoteResult, type RemoteExecResult } from "@/utils/project";

export type AgentToolRisk = "R0" | "R1" | "R2" | "R3" | "R4";

export type CommandResultStatus = "running" | "success" | "error" | "cancelled" | "partial_success";

export type CommandQueueItem = {
    id: string;
    data: string;
    useTimeMs: number;
    // running: 正在执行
    // success: 执行成功
    // error: 执行失败
    // cancelled: 取消执行
    // partial_success: 部分执行成功
    // 如果执行命令的服务器列表中，有部分服务器执行成功，部分服务器执行失败，则状态为 partial_success
    status: CommandResultStatus;
};

export type CommandQueueCall = (item: CommandQueueItem) => void;

export interface ToolOptions {
    commandQueueCall?: CommandQueueCall;
}

/** 静默命令使用独立执行 ID；AbortSignal 触发时通知 Rust 端中断对应 SSH channel。 */
async function execRemoteWithAbort(serverId: string, data: string, signal?: AbortSignal): Promise<RemoteExecResult> {
    signal?.throwIfAborted();
    const executionId = crypto.randomUUID();
    const cancel = () => {
        void cancelExecRemote(executionId).catch((error) => {
            console.error("取消远程命令失败:", error);
        });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
        return await execRemoteResult(serverId, data, executionId);
    } finally {
        signal?.removeEventListener("abort", cancel);
    }
}

/** 合并静默执行的两个输出流；无法还原跨流时序，但必须把 stderr 返回给 Agent 作为失败证据。 */
function mergeRemoteExecOutput(result: RemoteExecResult): string {
    if (!result.stdout) return result.stderr;
    if (!result.stderr) return result.stdout;
    return result.stdout.endsWith("\n") ? `${result.stdout}${result.stderr}` : `${result.stdout}\n${result.stderr}`;
}

/**
 * 使用skill
 */
export function useSkillTool(promptManager: PromptManager): StructuredToolInterface {
    return tool(({ name }) => promptManager.loadMarkdownBody(name, true), {
        name: "load_skill",
        // 可用 Skill 目录由 PromptManager 动态注入系统提示词，避免热重载后工具描述仍停留在旧列表。
        description: "按名称加载标准 Skill 的 SKILL.md。仅在任务匹配系统提示词列出的 Skill 时调用。",
        schema: z.object({
            name: z.string().describe("系统提示词中列出的 Skill 名称"),
        }),
    });
}

/**
 * 加载运维技能或补充文档的完整说明。
 * name 可以是相对 agents/ 的 md 路径，或 `<skill-name>/references/foo.md` 形式的 Skill 资源路径。
 * 用户问题匹配技能描述或系统提示词中的专题文档时必须先调用本工具，再按文档执行。
 */
export function loadDocBodyTool(promptManager: PromptManager) {
    return tool(({ name }) => promptManager.loadMarkdownBody(name, false), {
        name: "load_doc_body",
        description:
            "加载补充文档或标准 Skill 的按需资源。name 可以是相对 agents/ 的 md 路径（如 docs/change-and-rollback.md），" +
            "也可以是 <skill-name>/references/foo.md。" +
            "用户问题匹配技能描述或系统提示词中的专题文档时必须先调用本工具，再按文档执行。",
        schema: z.object({
            name: z.string().describe("相对 agents/ 的文档路径或 Skill 资源路径"),
        }),
    });
}

/**
 * 执行命令工具
 */
export function execCommandTool(modelManager: ModelConfigManager, idMap: Record<string, string>, commandQueueCall?: CommandQueueCall) {
    return tool(
        async ({ serverIds, data, watchDescription, watchTimeMs }, config: ToolRunnableConfig) => {
            const signal = config?.signal;
            signal?.throwIfAborted();
            const commandQueueItem: CommandQueueItem = {
                id: crypto.randomUUID(),
                data,
                useTimeMs: 0,
                status: "running",
            };
            commandQueueCall?.(commandQueueItem);
            const nowTimeMs = Date.now();
            try {
                const runtimeContext = getAgentRuntimeContext();
                // 是否在终端中执行
                const termExec = runtimeContext.commandExecution === "visual";
                if (termExec) {
                    return await visualExecCommand(
                        serverIds,
                        idMap,
                        modelManager,
                        data,
                        watchTimeMs,
                        commandQueueItem,
                        watchDescription,
                        signal,
                    );
                }
                return await silentExecCommand(serverIds, idMap, data, watchTimeMs, commandQueueItem, signal);
            } finally {
                if (signal?.aborted) {
                    commandQueueItem.status = "cancelled";
                } else if (commandQueueItem.status === "running") {
                    commandQueueItem.status = "error";
                } else {
                    commandQueueItem.status = commandQueueItem.status;
                }
                commandQueueItem.useTimeMs = Date.now() - nowTimeMs;
                commandQueueCall?.(commandQueueItem);
            }
        },
        {
            name: "exec_command",
            description:
                "在指定服务器列表执行 Shell 命令并返回 stdout/stderr。" +
                "工具结果仅用于后续分析，界面会自动在思考区域以 Shell 代码块展示。" +
                "不要在最终回复中原样复述命令或完整工具输出，也不要自行添加 Markdown 代码块；" +
                "最终回复只总结结论、异常和必要证据，除非用户明确要求查看原始输出。" +
                "执行结果是一个对象，键为服务器id，值为执行结果。",
            schema: z.object({
                serverIds: z.array(z.string()).describe("需要执行命令的服务器列表"),
                data: z.string().describe("执行的命令"),
                watchTimeMs: z
                    .number()
                    .max(3600_000) // 最大监听1小时
                    .describe(
                        "命令的观察时间（命令执行预估时间），避免无限制时间消耗。这个时间要个根据命令的复杂程度和执行时间来估算，不要估算的太短。（超时或者观察结束条件任意一个达到后就会结束观察）",
                    ),
                watchDescription: z
                    .string()
                    .describe(
                        "命令结束条件。会自行退出的命令不传值或者只能传【等待命令执行完成】；top、watch、tail -f 等常驻命令必须写清何时可以停，例如「出现一行 ERROR」「采集到一屏进程列表」。",
                    )
                    .default(""),
            }),
        },
    );
}

/**
 * 静默执行命令
 */
async function silentExecCommand(
    serverIds: string[],
    idMap: Record<string, string>,
    data: string,
    watchTimeMs: number,
    commandQueueItem: CommandQueueItem,
    signal?: AbortSignal,
) {
    // 给每个执行命令加上signal信号
    const serversx = serverIds.map((serverId) => {
        return {
            serverId,
            signal: new AbortSignal(),
        };
    });
    const cancelAll = () => {
        serversx.forEach((server) => {
            server.signal.throwIfAborted();
        });
    };
    // 超时取消所有命令
    const timeout = setTimeout(cancelAll, watchTimeMs);
    signal?.addEventListener("abort", cancelAll, { once: true });
    // 静默执行命令
    const results = await Promise.all(
        serversx.map(async (server) => {
            try {
                const execResult = await execRemoteWithAbort(server.serverId, data, server.signal);
                const result = mergeRemoteExecOutput(execResult);
                if (execResult.exitCode !== null && execResult.exitCode !== undefined) {
                    return { serverId: server.serverId, result, status: execResult.exitCode === 0 ? "success" : "error" };
                }
                // 静默执行有可靠退出码时直接使用；只有服务端未返回 ExitStatus 才降级为文本判断。
                const status = parseCommandResultIsSuccess(data, result);
                return { serverId: server.serverId, result, status };
            } catch (error) {
                return { serverId: server.serverId, result: "静默执行失败", status: "error" };
            }
        }),
    ).finally(() => {
        signal?.removeEventListener("abort", cancelAll);
        clearTimeout(timeout);
    });
    // 计算命令执行状态
    const allSuccess = results.every((result) => result.status === "success");
    const allError = results.every((result) => result.status === "error");
    if (allSuccess) commandQueueItem.status = "success";
    else if (allError) commandQueueItem.status = "error";
    else commandQueueItem.status = "partial_success";
    // 返回执行结果
    return results.reduce(
        (acc, result) => {
            acc[result.serverId] = result.result;
            return acc;
        },
        {} as Record<string, string>,
    );
}

/**
 * 可视化执行命令
 */
async function visualExecCommand(
    serverIds: string[],
    idMap: Record<string, string>,
    modelManager: ModelConfigManager,
    data: string,
    watchTimeMs: number,
    commandQueueItem: CommandQueueItem,
    watchDescription: string,
    signal?: AbortSignal,
) {
    const watchEndTimeMs = Date.now() + watchTimeMs; // 超时时间
    interface Item {
        result: string;
        status: CommandResultStatus;
        lineCount: number;
        term?: TermServer;
    }
    const resultItems: Record<string, Item> = {};
    for (const serverId of serverIds) {
        const termServer = TermServer.getTermServer(idMap[serverId]);
        if (!termServer) {
            resultItems[serverId] = {
                result: "终端不存在，请先连接终端。",
                status: "error",
                lineCount: 0,
            };
        } else if (!termServer._active()) {
            resultItems[serverId] = {
                result: "终端已关闭，请先连接终端。",
                status: "error",
                lineCount: 0,
            };
        } else {
            resultItems[serverId] = {
                result: "",
                status: "running",
                lineCount: termServer.lineCount,
                term: termServer,
            };
            await termServer.write(data + "\n");
        }
    }
    const interrupt = () => {
        for (const item in resultItems) {
            resultItems[item].term?.write("\x03");
        }
    };
    // 如果信号已中断，直接返回
    if (signal?.aborted) {
        interrupt();
        return {};
    }
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
        signal?.throwIfAborted();
        await sleep(100, signal);
        const useAiWatch = Boolean(watchDescription && watchDescription !== "等待命令执行完成");
        let _nowTimeMs = Date.now();
        let watchIndex = 0;
        for (let i = 0; _nowTimeMs < watchEndTimeMs && watchIndex < serverIds.length; i++, _nowTimeMs = Date.now()) {
            signal?.throwIfAborted();
            const serverId = serverIds[watchIndex];
            const resultItem = resultItems[serverIds[watchIndex]];
            if (!resultItem.term) {
                // 终端不存在，跳过
                watchIndex++;
                continue;
            }
            const snapshot = snapshotTerminal(idMap[serverId]!, resultItem.lineCount);
            console.log("data:::\n", data);
            console.log("snapshot:::\n", snapshot);
            console.log("\n\n\n");
            let result = null;
            if (useAiWatch) {
                result = await runTerminalWatchAgent(
                    modelManager,
                    {
                        snapshot,
                        command: data,
                        watchDescription,
                    },
                    signal,
                );
            } else if (parseCommandResultShouldStopWatching(data, snapshot)) {
                result = snapshot;
            }
            if (result) {
                resultItem.result = result;
                resultItem.status = parseCommandResultIsSuccess(data, result);
                watchIndex++; // 成功后，跳到下一个终端
                continue; // 下一个终端时可以不sleep
            }
            if (useAiWatch) {
                await increasingSleep(i, TERMINAL_WATCH_SETTLE_MS, signal);
            } else {
                await sleep(TERMINAL_WATCH_SETTLE_MS, signal);
            }
        }
        for (const serverId in resultItems) {
            const resultItem = resultItems[serverId];
            if (resultItem.status === "running") {
                const sessionId = idMap[serverId];
                const snapshot = snapshotTerminal(sessionId, resultItem.lineCount);
                resultItem.term?.write("\x03");
                resultItem.status = "error";
                resultItem.result = `观察超时，以下是当前终端增量：\n${snapshot}`;
            }
        }
        const values = Object.values(resultItems);
        const allSuccess = values.every((item) => item.status === "success");
        const allError = values.every((item) => item.status === "error");
        if (allSuccess) commandQueueItem.status = "success";
        else if (allError) commandQueueItem.status = "error";
        else commandQueueItem.status = "partial_success";
        return Object.keys(resultItems).reduce(
            (acc, serverId) => {
                const resultItem = resultItems[serverId];
                acc[serverId] = resultItem.result;
                return acc;
            },
            {} as Record<string, string>,
        );
    } finally {
        signal?.removeEventListener("abort", interrupt);
    }
}

/**
 * 询问是否执行命令
 */
export function askToExecuteTool() {
    return tool(
        async ({ title, message }) => {
            return showConfirm({
                title,
                message,
                confirmText: "确认执行",
                cancelText: "取消",
                danger: true,
            });
        },
        {
            name: "ask_to_execute",
            description: "询问是否执行命令，如果执行则返回true，否则返回false",
            schema: z.object({
                title: z.string().describe("标题"),
                message: z.string().describe("具体执行命令的风险，使用紧凑的html格式，高风险的地方使用红色文字提示。"),
            }),
        },
    );
}

export function createBuiltinTools(
    promptManager: PromptManager,
    modelManager: ModelConfigManager,
    options: ToolOptions,
    serverIdMap: Record<string, string>,
): StructuredToolInterface[] {
    // commandExecution=silent 走后台 exec，visual 写入当前终端；watchResult 时由 subAgent 观察输出。
    return [
        useSkillTool(promptManager),
        loadDocBodyTool(promptManager),
        execCommandTool(modelManager, serverIdMap, options.commandQueueCall),
        askToExecuteTool(),
    ];
}

/** 获取终端增量 */
export function snapshotTerminal(sessionId: string, startLine: number): string {
    const termServer = TermServer.getTermServer(sessionId);
    if (!termServer) return "";
    return termServer.lineData.slice(startLine).join("\n");
}
