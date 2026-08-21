import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { ModelConfig } from "../config/schema";

/**
 * 按配置创建 ChatModel。
 * 目前统一走 ChatOpenAI：官方 OpenAI 和各类兼容网关都用同一套协议。
 */
export function createChatModel(config: ModelConfig): ChatOpenAI {
    if (!config.apiKey) {
        throw new Error("模型 apiKey 为空。请在设置窗口的 Agent 页面中填写 API Key。");
    }
    if (config.provider === "openai-compatible" && !config.baseURL) {
        // 兼容网关没填 baseURL 时仍允许走官方默认地址，但给出提示便于排查
        console.warn("[langgraph-agent] provider=openai-compatible 但 baseURL 为空，将使用 OpenAI 官方默认地址。");
    }

    return new ChatOpenAI({
        model: config.model,
        apiKey: config.apiKey,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        // 打开后 POST 带 stream:true。不要对这个实例调 invoke()，见 collectChatModelResponse。
        streaming: true,
        // reasoning 由 LangChain 仅对其识别的推理模型透传；兼容网关仍会收到节点层的运行提示。
        reasoning: { effort: config.reasoningEffort },
        timeout: config.timeout,
        maxRetries: config.maxRetries,
        configuration: config.baseURL ? { baseURL: config.baseURL } : undefined,
    });
}

/**
 * 收集一次完整模型回复。
 *
 * streaming:true 时 invoke() 会在 SSE 结束后再 getNumTokens()，去拉
 * https://tiktoken.pages.dev 的词表；国内 / Tauri WebView 里这个请求经常一直 pending，
 * invoke 就永不返回。stream() 只消费 SSE，不走那段估算。主 Agent llmCall 也是同一条路。
 */
export async function collectChatModelResponse(model: ChatOpenAI, messages: BaseMessage[], signal?: AbortSignal): Promise<AIMessageChunk> {
    let response: AIMessageChunk | undefined;
    const stream = await model.stream(messages, { signal });
    for await (const chunk of stream) {
        response = response ? response.concat(chunk) : chunk;
    }
    if (!response) {
        throw new Error("模型没有返回任何内容。");
    }
    return response;
}
