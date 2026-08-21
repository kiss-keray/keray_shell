import { type ChatOpenAI } from "@langchain/openai";
import { watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { DEFAULT_CONFIG_PATH } from "../paths";
import { ensureModelConfigFile, loadModelConfig, writeModelConfig } from "./loader";
import {
    fingerprintModelConfig,
    MIN_CONTEXT_WINDOW_TOKENS,
    ModelProfileSchema,
    ModelsConfigSchema,
    resolveActiveModelId,
    type ModelConfig,
    type ModelProfile,
    type ModelsConfig,
} from "./schema";
import { createChatModel } from "../model/factory";
import type { AgentReasoningEffort } from "../context";

export type ModelConfigListener = (next: ModelConfig, prev: ModelConfig) => void;

/** 用户主动切换模型时触发；与 onReload 区分：热重载和推理深度等参数调整不算切换。 */
export type ModelSelectListener = (next: ModelProfile, prev: ModelConfig) => void;

export interface ModelConfigManagerOptions {
    /** 文件变更防抖，避免编辑器连续写入触发多次重建 */
    debounceMs?: number;
}

/**
 * 模型配置管理器。配置固定为 ~/.cache/keray_shell/model.json。
 *
 * 热重载思路：
 * 1. Graph 在 compile 时不绑定具体 ChatModel，节点每次 llmCall 都通过 getChatModel() 取实例
 * 2. 文件变更后异步重载配置，只失效模型缓存，图拓扑保持不变
 * 3. 进行中的 invoke 继续用旧实例；下一次节点执行自动切到新模型
 */
export class ModelConfigManager {
    /** 固定配置路径：~/.cache/keray_shell/model.json */
    readonly configPath = DEFAULT_CONFIG_PATH;
    private readonly debounceMs: number;
    private configs: ModelsConfig;
    /** 当前使用的默认模型，启动时从 model.json 的 activeModelId 恢复。 */
    private selectedModelId: string;
    private config: ModelConfig;
    private fingerprint: string;
    private model: ChatOpenAI | null = null;
    private unwatch: UnwatchFn | null = null;
    private readonly listeners = new Set<ModelConfigListener>();
    private readonly selectListeners = new Set<ModelSelectListener>();

    private constructor(configs: ModelsConfig, options: ModelConfigManagerOptions) {
        this.debounceMs = options.debounceMs ?? 200;
        this.configs = configs;
        const initial = this.findInitialModel(configs);
        this.selectedModelId = initial.id;
        this.config = initial;
        this.fingerprint = this.createSelectedFingerprint(initial);
    }

    /** Tauri 文件 API 为异步接口，管理器必须通过此工厂完成初始化。 */
    static async create(options: ModelConfigManagerOptions = {}): Promise<ModelConfigManager> {
        await ensureModelConfigFile(DEFAULT_CONFIG_PATH);
        return new ModelConfigManager(await loadModelConfig(DEFAULT_CONFIG_PATH), options);
    }

    /**
     * 返回当前实际生效的模型配置，包含输入区已保存的推理深度和上下文预算。
     */
    getConfig(): ModelConfig {
        return this.config;
    }

    getSelectedModelId(): string {
        return this.selectedModelId;
    }

    /** 返回完整模型列表，调用方不得直接修改返回值。 */
    getModelsConfig(): ModelsConfig {
        return this.configs;
    }

    /**
     * 切换默认模型并写回 model.json。
     * 下次启动会从 activeModelId 恢复；该模型自己的推理深度和上下文预算一并生效。
     */
    async selectModel(modelId: string, persist = true): Promise<boolean> {
        const next = this.findModel(this.configs, modelId);
        if (modelId === this.selectedModelId) return false;
        const prev = this.getConfig();
        this.selectedModelId = modelId;
        this.config = next;
        this.fingerprint = this.createSelectedFingerprint(next);
        this.model = null;
        this.configs = { ...this.configs, activeModelId: modelId };
        this.emitReload(this.getConfig(), prev);
        this.emitSelect(next, prev);
        if (persist) await this.persistConfigs();
        return true;
    }

    /**
     * 更新当前模型的推理深度并写回 model.json。
     * reasoning 会进入 ChatOpenAI 构造参数，因此必须丢掉缓存实例。
     */
    async setReasoningEffort(value: AgentReasoningEffort, persist = true): Promise<ModelConfig> {
        if (this.getConfig().reasoningEffort === value) return this.getConfig();
        return await this.updateConfig({ reasoningEffort: value }, persist);
    }

    /**
     * 更新当前模型送入模型的上下文预算并写回 model.json。
     * 该值只影响 llmCall 的历史裁剪；指纹变化时 applyConfigs 会决定是否重建 ChatModel。
     */
    async setContextWindowTokens(value: number, persist = true): Promise<ModelConfig> {
        const normalized = this.normalizeContextWindow(value, this.config.maxContextWindowTokens);
        if (this.getConfig().contextWindowTokens === normalized) return this.getConfig();
        return await this.updateConfig({ contextWindowTokens: normalized }, persist);
    }

    /** 返回当前 ChatModel。配置指纹没变就复用实例，变了才新建。 */
    getChatModel(): ChatOpenAI {
        if (!this.model) {
            this.model = createChatModel(this.getConfig());
        }
        return this.model;
    }

    /** 订阅热重载。返回取消订阅函数。 */
    onReload(listener: ModelConfigListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 订阅用户主动切换模型。返回取消订阅函数。 */
    onModelSelect(listener: ModelSelectListener): () => void {
        this.selectListeners.add(listener);
        return () => {
            this.selectListeners.delete(listener);
        };
    }

    /** 从磁盘重新加载。校验失败时保留上一份配置，避免把正在跑的 Agent 打挂。 */
    async reloadFromDisk(): Promise<boolean> {
        try {
            return this.applyConfigs(await loadModelConfig(this.configPath));
        } catch (error) {
            console.error("[langgraph-agent] 模型配置热重载失败，继续使用上一份配置:", error);
            return false;
        }
    }

    /**
     * 运行时修改配置。先做完整 Schema 校验；persist=true 时等待写盘完成再返回。
     * 文件监听随后可能再次读取，但配置指纹相同会直接跳过。
     */
    async updateConfig(partial: Partial<ModelConfig>, persist = false): Promise<ModelConfig> {
        const selectedIndex = this.configs.models.findIndex((model) => model.id === this.selectedModelId);
        const selected = ModelProfileSchema.parse({ ...this.configs.models[selectedIndex], ...partial });
        const next = ModelsConfigSchema.parse({
            ...this.configs,
            activeModelId: this.selectedModelId,
            models: this.configs.models.map((model, index) => (index === selectedIndex ? selected : model)),
        });
        this.applyConfigs(next);
        if (persist) {
            await this.persistConfigs();
        }
        return this.getConfig();
    }

    /** 监听 model.json；Tauri 插件在 Rust 侧完成防抖，再通知前端重载。 */
    async startWatch(): Promise<void> {
        if (this.unwatch) return;
        this.unwatch = await watch(
            this.configPath,
            () => {
                // watch 的回调不能等待 Promise，显式捕获异常避免未处理拒绝。
                void this.reloadFromDisk();
            },
            { delayMs: this.debounceMs },
        );
    }

    stopWatch(): void {
        this.unwatch?.();
        this.unwatch = null;
    }

    dispose(): void {
        this.stopWatch();
        this.listeners.clear();
        this.selectListeners.clear();
        this.model = null;
    }

    private applyConfigs(next: ModelsConfig): boolean {
        // 热重载以文件里的默认模型为准；该条目被删掉后才回退到仍存在的运行时选择或列表第一项。
        const preferredId = resolveActiveModelId(next.models, next.activeModelId ?? this.selectedModelId);
        const nextSelected = this.findModel(next, preferredId);
        const nextFingerprint = this.createSelectedFingerprint(nextSelected);
        if (nextFingerprint === this.fingerprint) {
            // 非当前模型也需要更新内存列表；当前条目引用同步为新对象，但无需重建 ChatModel。
            this.configs = next;
            this.selectedModelId = nextSelected.id;
            this.config = nextSelected;
            return false;
        }
        const prev = this.getConfig();
        this.configs = next;
        this.selectedModelId = nextSelected.id;
        this.config = nextSelected;
        this.fingerprint = nextFingerprint;
        this.model = null;
        this.emitReload(this.getConfig(), prev);
        return true;
    }

    /** 把当前模型列表和默认选择写回磁盘；失败只记日志，避免打断已经生效的运行时切换。 */
    private async persistConfigs(): Promise<void> {
        try {
            this.configs = { ...this.configs, activeModelId: this.selectedModelId };
            await writeModelConfig(this.configPath, this.configs);
        } catch (error) {
            console.error("[langgraph-agent] 保存模型配置失败:", error);
        }
    }

    private findInitialModel(configs: ModelsConfig): ModelProfile {
        return this.findModel(configs, resolveActiveModelId(configs.models, configs.activeModelId));
    }

    /** 滑动条和程序式调用都收敛到 1K 步进，并夹在模型声明的合法范围内。 */
    private normalizeContextWindow(value: number, maximum: number): number {
        return Math.min(maximum, Math.max(MIN_CONTEXT_WINDOW_TOKENS, Math.round(value / 1_000) * 1_000));
    }

    private findModel(configs: ModelsConfig, modelId: string): ModelProfile {
        const model = configs.models.find((item) => item.id === modelId);
        if (!model) throw new Error(`模型配置不存在: ${modelId}`);
        return model;
    }

    /** 模型 id 进入指纹，切换到参数完全相同的另一条配置时仍会触发重载事件。 */
    private createSelectedFingerprint(model: ModelProfile): string {
        return `${model.id}:${fingerprintModelConfig(model)}`;
    }

    private emitReload(next: ModelConfig, prev: ModelConfig) {
        for (const listener of this.listeners) listener(next, prev);
    }

    private emitSelect(next: ModelProfile, prev: ModelConfig) {
        for (const listener of this.selectListeners) listener(next, prev);
    }
}
