import { z } from "zod";

/** 输入区与设置页滑动条共用的下限。 */
export const MIN_CONTEXT_WINDOW_TOKENS = 16_000;
/** 模型最大上下文声明上限，同时约束 schema 和设置页滑动条。 */
export const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
/** 多数旧版对话模型的窗口，也作为新建条目的默认会话预算。 */
const CONTEXT_128K_TOKENS = 128_000;
/** 通义 qwen3-max 系列官方窗口为 256K。 */
const CONTEXT_256K_TOKENS = 256_000;
/** DeepSeek V4 / 通义 Plus 等 1M 窗口，不能跟设置页 10M 上限共用同一个常量。 */
const CONTEXT_1M_TOKENS = 1_000_000;

/** 把 token 数格式化成 16K / 1M / 10M，供滑动条刻度显示。 */
export function formatContextTokens(value: number): string {
    if (value >= 1_000_000) {
        const millions = value / 1_000_000;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (value >= 1_000) {
        const thousands = value / 1_000;
        return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1).replace(/\.0$/, "")}K`;
    }
    return String(value);
}

/**
 * 设置页三种接入场景里常见模型的最大上下文。
 * 按最长前缀匹配，因此 `qwen-plus-2025-04-28`、`llama3.1:70b` 这类快照/标签也能命中。
 * 只收录不低于滑动条下限的窗口；未知模型回退到 MIN_CONTEXT_WINDOW_TOKENS。
 */
const MODEL_MAX_CONTEXT_MAP: Record<string, number> = {
    // DeepSeek：官方 API 当前是 V4 Flash / Pro，均为 1M；旧版与蒸馏版为 128K。
    "deepseek-v4-flash": CONTEXT_1M_TOKENS,
    "deepseek-v4-pro": CONTEXT_1M_TOKENS,
    "deepseek-v4": CONTEXT_1M_TOKENS,
    "deepseek-chat": CONTEXT_128K_TOKENS,
    "deepseek-reasoner": CONTEXT_128K_TOKENS,
    "deepseek-coder": CONTEXT_128K_TOKENS,
    "deepseek-v3.2": CONTEXT_128K_TOKENS,
    "deepseek-v3.1": CONTEXT_128K_TOKENS,
    "deepseek-v3": CONTEXT_128K_TOKENS,
    "deepseek-r1-distill-qwen-32b": CONTEXT_128K_TOKENS,
    "deepseek-r1-distill-qwen-14b": CONTEXT_128K_TOKENS,
    "deepseek-r1-distill-qwen-7b": CONTEXT_128K_TOKENS,
    "deepseek-r1-distill-qwen-1.5b": CONTEXT_128K_TOKENS,
    "deepseek-r1-distill-llama-70b": CONTEXT_128K_TOKENS,
    "deepseek-r1-distill-llama-8b": CONTEXT_128K_TOKENS,
    "deepseek-r1-0528": CONTEXT_128K_TOKENS,
    "deepseek-r1": CONTEXT_128K_TOKENS,
    // 通义千问：百炼 OpenAI 兼容接口的常用商业模型。
    "qwen3.8-max": CONTEXT_1M_TOKENS,
    "qwen3.8": CONTEXT_1M_TOKENS,
    "qwen3.7-max": CONTEXT_1M_TOKENS,
    "qwen3.7-plus": CONTEXT_1M_TOKENS,
    "qwen3.7-flash": CONTEXT_1M_TOKENS,
    "qwen3.7": CONTEXT_1M_TOKENS,
    "qwen3.6-plus": CONTEXT_1M_TOKENS,
    "qwen3.6-flash": CONTEXT_1M_TOKENS,
    "qwen3.6": CONTEXT_1M_TOKENS,
    "qwen3.5-plus": CONTEXT_1M_TOKENS,
    "qwen3.5-flash": CONTEXT_1M_TOKENS,
    "qwen3-coder-plus": CONTEXT_1M_TOKENS,
    "qwen3-coder-flash": CONTEXT_1M_TOKENS,
    "qwen3-max": CONTEXT_256K_TOKENS,
    "qwen-plus": CONTEXT_1M_TOKENS,
    "qwen-flash": CONTEXT_1M_TOKENS,
    "qwen-turbo": CONTEXT_1M_TOKENS,
    "qwen-long": MAX_CONTEXT_WINDOW_TOKENS,
    "qwen-max": CONTEXT_128K_TOKENS,
    "qwq-plus": CONTEXT_128K_TOKENS,
    qwq: CONTEXT_128K_TOKENS,
    // Ollama：架构上限；实际窗口还受 Modelfile 的 num_ctx 限制。
    "llama3.3": CONTEXT_128K_TOKENS,
    "llama3.2": CONTEXT_128K_TOKENS,
    "llama3.1": CONTEXT_128K_TOKENS,
    gemma3: CONTEXT_128K_TOKENS,
    "mistral-nemo": CONTEXT_128K_TOKENS,
    "mistral-large": CONTEXT_128K_TOKENS,
    "command-r-plus": CONTEXT_128K_TOKENS,
    "command-r": CONTEXT_128K_TOKENS,
};

/** 长前缀优先，避免 `deepseek-v4` 抢先匹配 `deepseek-v4-flash`。 */
const MODEL_MAX_CONTEXT_PREFIXES = Object.entries(MODEL_MAX_CONTEXT_MAP).sort((left, right) => right[0].length - left[0].length);

/** 模型名是否命中表中的精确 id 或带分隔符的前缀（日期快照、Ollama 标签）。 */
function matchModelContextPrefix(model: string, prefix: string): boolean {
    if (model === prefix) return true;
    if (!model.startsWith(prefix)) return false;
    const next = model.charAt(prefix.length);
    return next === "-" || next === "." || next === ":";
}

/**
 * 按模型名解析最大上下文。未知模型回退到滑动条下限，调用方可再手动覆盖。
 */
export function resolveMaxContextWindowTokens(model: string): number {
    const name = model.trim().toLowerCase();
    if (!name) return MIN_CONTEXT_WINDOW_TOKENS;
    for (const [prefix, tokens] of MODEL_MAX_CONTEXT_PREFIXES) {
        if (matchModelContextPrefix(name, prefix)) return tokens;
    }
    return MIN_CONTEXT_WINDOW_TOKENS;
}

/**
 * 模型配置 Schema。
 * 改这个文件会在下次热重载时被校验；不合法的 JSON 会被拒绝并保留上一份可用配置。
 */
const modelConfigShape = {
    /** openai 走官方接口；openai-compatible 走任意 OpenAI 协议网关（DeepSeek / 通义 / Ollama 等） */
    provider: z.enum(["openai-compatible"]).default("openai-compatible"),
    /** 模型名，例如 deepseek-v4-flash */
    model: z.string().min(1, "model 不能为空").default("deepseek-v4-flash"),
    /** OpenAI 兼容网关地址，例如 https://api.deepseek.com。deepseek 官方可留空 */
    baseURL: z.string().default("https://api.deepseek.com"),
    temperature: z.number().min(0).max(2).default(0.2),
    /** 模型最大输出 token 数；可选，缺省时使用模型自身限制。 */
    maxTokens: z.number().int().positive().optional(),
    /** 输入区的推理深度会作为模型调用参数和运行提示共同生效。 */
    reasoningEffort: z.enum(["low", "medium", "high"]).default("high"),
    /** 当前会话送入模型的上下文预算；最小值与输入区滑动条保持一致。 */
    contextWindowTokens: z.number().int().min(MIN_CONTEXT_WINDOW_TOKENS).max(MAX_CONTEXT_WINDOW_TOKENS).default(CONTEXT_128K_TOKENS),
    /** 模型自身支持的最大上下文，输入区以此作为滑动条上限。 */
    maxContextWindowTokens: z
        .number()
        .int()
        .min(MIN_CONTEXT_WINDOW_TOKENS)
        .max(MAX_CONTEXT_WINDOW_TOKENS)
        .default(MIN_CONTEXT_WINDOW_TOKENS),
    timeout: z.number().int().positive().default(60_000),
    maxRetries: z.number().int().min(0).default(2),
};

/** 设置页草稿允许 API Key 暂时为空，便于首次启动时展示可编辑表单。 */
export const ModelConfigDraftSchema = z.object({
    ...modelConfigShape,
    apiKey: z.string().default(""),
});

/** Agent 运行及配置落盘前使用严格 Schema，API Key 必须由用户直接填写。 */
export const ModelConfigSchema = ModelConfigDraftSchema.extend({
    apiKey: z.string().trim().min(1, "API Key 不能为空"),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/** 默认模型按名称表填充最大上下文，避免 V4 这类 1M 模型被写成滑动条下限。 */
const parsedDefaultModel = ModelConfigDraftSchema.parse({});
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
    ...parsedDefaultModel,
    maxContextWindowTokens: resolveMaxContextWindowTokens(parsedDefaultModel.model),
};

/**
 * 单个模型条目使用稳定 id 作为选择键。
 * 不能直接用 model 字段做键，因为同一模型可能配置不同的网关或 API Key。
 */
export const ModelProfileDraftSchema = ModelConfigDraftSchema.extend({
    id: z.string().trim().min(1, "模型 id 不能为空"),
});

export const ModelProfileSchema = ModelConfigSchema.extend({
    id: z.string().trim().min(1, "模型 id 不能为空"),
});

function validateModelProfiles(config: { models: { id: string }[]; activeModelId?: string }, context: z.RefinementCtx) {
    const ids = new Set<string>();
    for (let index = 0; index < config.models.length; index += 1) {
        const id = config.models[index].id;
        if (ids.has(id)) {
            context.addIssue({ code: "custom", path: ["models", index, "id"], message: "模型 id 不能重复" });
        }
        const model = config.models[index] as { contextWindowTokens?: number; maxContextWindowTokens?: number };
        if (model.contextWindowTokens && model.maxContextWindowTokens && model.contextWindowTokens > model.maxContextWindowTokens) {
            context.addIssue({
                code: "custom",
                path: ["models", index, "contextWindowTokens"],
                message: "当前上下文不能超过模型最大上下文",
            });
        }
        ids.add(id);
    }
    // 有值才校验，兼容还没写过 activeModelId 的旧 model.json。
    if (config.activeModelId && !ids.has(config.activeModelId)) {
        context.addIssue({ code: "custom", path: ["activeModelId"], message: "默认模型 id 不存在" });
    }
}

const modelsConfigShape = {
    models: z.array(ModelProfileDraftSchema).min(1, "至少需要配置一个模型"),
    /** 输入区当前使用的默认模型；缺省时运行时回退到列表第一项。 */
    activeModelId: z.string().trim().min(1).optional(),
};

/** 设置页草稿结构：允许每个模型的 API Key 暂时为空。 */
export const ModelsConfigDraftSchema = z
    .object({
        ...modelsConfigShape,
        models: z.array(ModelProfileDraftSchema).min(1, "至少需要配置一个模型"),
    })
    .superRefine(validateModelProfiles);

/** model.json 的正式结构：所有模型都必须通过严格校验。 */
export const ModelsConfigSchema = z
    .object({
        ...modelsConfigShape,
        models: z.array(ModelProfileSchema).min(1, "至少需要配置一个模型"),
    })
    .superRefine(validateModelProfiles);

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

/** 输入区保存的默认模型；条目被删除或不存在时回退到列表第一项。 */
export function resolveActiveModelId(models: { id: string }[], preferred?: string): string {
    if (preferred && models.some((model) => model.id === preferred)) return preferred;
    return models[0]?.id ?? "";
}

/** 新安装默认创建一个模型条目；用户可在设置页继续新增。 */
export const DEFAULT_MODELS_CONFIG: ModelsConfig = ModelsConfigDraftSchema.parse({
    models: [{ id: "default", ...DEFAULT_MODEL_CONFIG }],
    activeModelId: "default",
});

/**
 * 生成配置指纹。指纹变化才重建 ChatModel，避免编辑器保存空白改动时无意义重建。
 */
export function fingerprintModelConfig(config: ModelConfig): string {
    return JSON.stringify({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        temperature: config.temperature,
        maxTokens: config.maxTokens ?? null,
        reasoningEffort: config.reasoningEffort,
        contextWindowTokens: config.contextWindowTokens,
        maxContextWindowTokens: config.maxContextWindowTokens,
        timeout: config.timeout,
        maxRetries: config.maxRetries,
    });
}

/** 打印用：隐藏完整 apiKey */
export function redactModelConfig(config: ModelConfig): ModelConfig {
    const masked = config.apiKey ? `${config.apiKey.slice(0, 4)}***` : "";
    const maxContextWindowTokens = MODEL_MAX_CONTEXT_MAP[config.model as keyof typeof MODEL_MAX_CONTEXT_MAP];
    return { ...config, apiKey: masked, maxContextWindowTokens: maxContextWindowTokens ?? config.maxContextWindowTokens };
}
