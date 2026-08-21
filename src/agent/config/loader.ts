import { dirname } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
    DEFAULT_MODELS_CONFIG,
    ModelConfigDraftSchema,
    ModelConfigSchema,
    ModelsConfigDraftSchema,
    ModelsConfigSchema,
    resolveMaxContextWindowTokens,
    type ModelsConfig,
} from "./schema";

/** 旧配置没写最大上下文时，按模型名从表里补上，保留用户已经手填的值。 */
function hydrateMaxContextWindow(raw: Record<string, unknown>): Record<string, unknown> {
    if (typeof raw.model !== "string" || "maxContextWindowTokens" in raw) return raw;
    return { ...raw, maxContextWindowTokens: resolveMaxContextWindowTokens(raw.model) };
}

/** 兼容旧版单模型对象和新版 models 数组。 */
function hydrateModelsConfigRaw(raw: Record<string, unknown>): Record<string, unknown> {
    if (Array.isArray(raw.models)) {
        return {
            ...raw,
            models: raw.models.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? hydrateMaxContextWindow(item as Record<string, unknown>) : item)),
        };
    }
    return hydrateMaxContextWindow(raw);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
    const raw = await readTextFile(path);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`配置文件必须是 JSON 对象: ${path}`);
    }
    return parsed as Record<string, unknown>;
}

/**
 * 读取并校验 ~/.cache/keray_shell/model.json。
 *
 * Tauri 的文件 API 是异步的，所以从 Node 迁移后所有磁盘操作都必须 await：
 * 1. 读取固定路径上的 JSON
 * 2. 通过 Zod 校验（包括必填的 apiKey）
 * 3. 校验失败时由调用方保留上一份可用配置
 */
export async function loadModelConfig(configPath: string): Promise<ModelsConfig> {
    if (!(await exists(configPath))) {
        throw new Error(`找不到模型配置文件: ${configPath}`);
    }

    const raw = hydrateModelsConfigRaw(await readJsonObject(configPath));
    if ("models" in raw || "activeModelId" in raw) {
        // 已经是多模型结构时直接报告真实字段错误，不能误降级成旧版单模型解析。
        return ModelsConfigSchema.parse(raw);
    }

    // 兼容旧版单模型 model.json；下次从设置页保存时会自动写成 models 数组结构。
    const legacy = ModelConfigSchema.parse(raw);
    return ModelsConfigSchema.parse({
        models: [{ id: "legacy-default", ...legacy }],
    });
}

/** 设置页读取草稿时允许 apiKey 为空；真正保存前仍必须经过严格 Schema 校验。 */
export async function loadModelConfigDraft(configPath: string): Promise<ModelsConfig> {
    if (!(await exists(configPath))) {
        throw new Error(`找不到模型配置文件: ${configPath}`);
    }

    const raw = hydrateModelsConfigRaw(await readJsonObject(configPath));
    if ("models" in raw || "activeModelId" in raw) {
        return ModelsConfigDraftSchema.parse(raw);
    }

    // 草稿读取同样兼容旧结构，并保留空 API Key 的首次配置场景。
    const legacy = ModelConfigDraftSchema.parse(raw);
    return ModelsConfigDraftSchema.parse({
        models: [{ id: "legacy-default", ...legacy }],
    });
}

/** 把模型列表和当前选择一起写回磁盘，供设置页及热更新使用。 */
export async function writeModelConfig(path: string, config: ModelsConfig): Promise<void> {
    await mkdir(await dirname(path), { recursive: true });
    await writeTextFile(path, `${JSON.stringify(config, null, 4)}\n`, {
        create: true,
        createNew: false,
    });
}

/** 主配置缺失时写入一份默认文件，保证首次启动可热重载。 */
export async function ensureModelConfigFile(path: string): Promise<void> {
    if (await exists(path)) return;
    await writeModelConfig(path, DEFAULT_MODELS_CONFIG);
}
