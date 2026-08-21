import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ModelConfigManager } from "../config/manager";
import type { PromptManager } from "../prompt/manager";
import { createLlmCallNode, createToolNode, shouldContinue } from "./nodes";
import { AgentState } from "./state";
import type { ContextCompressionTracker } from "../contextCompression";

/**
 * 编译基础 ReAct Agent 图：
 *
 * START -> llmCall -> (有工具调用) toolNode -> llmCall ...
 *                 \-> END
 *
 * 模型和提示词都不在 compile 时固化，运行时分别向 ModelConfigManager / PromptManager 取最新值。
 */
export function compileAgentGraph(
    modelManager: ModelConfigManager,
    promptManager: PromptManager,
    tools: StructuredToolInterface[],
    servers: ChannelInstance[],
    compressionTracker: ContextCompressionTracker,
) {
    const llmCall = createLlmCallNode(modelManager, promptManager, tools, servers, compressionTracker);
    const toolNode = createToolNode(tools);
    // 只用内存检查点：进程内切标签能续上，重载后要靠 restoreThreadIfEmpty 把 UI 历史灌回来。
    const checkpointer = new MemorySaver();

    return new StateGraph(AgentState)
        .addNode("llmCall", llmCall)
        .addNode("toolNode", toolNode)
        .addEdge(START, "llmCall")
        .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
        .addEdge("toolNode", "llmCall")
        .compile({ checkpointer });
}

export type CompiledAgentGraph = ReturnType<typeof compileAgentGraph>;
