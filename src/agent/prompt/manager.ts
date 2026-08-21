import { basename, dirname, join, resolve, sep } from "@tauri-apps/api/path";
import { exists, readDir, watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { AGENTS_DIR, DEFAULT_PROMPT_PATH } from "../paths";
import { isStandardSkillName, SKILL_ENTRY_FILE } from "../skillFormat";
import { resolveIncludePath, resolveMarkdownFile, type ResolvedMarkdown } from "./include";

export interface AgentSkill {
    /** 标准技能名，必须与所在目录名一致。 */
    name: string;
    description: string;
    path: string;
    body: string;
}

export type PromptReloadListener = () => void;

export interface PromptManagerOptions {
    agentsDir?: string;
    promptPath?: string;
    debounceMs?: number;
}

/**
 * 提示词与技能管理。
 *
 * - builtin/default.md：Agent 系统提示词
 * - builtin/custom 的 skills/<name>/SKILL.md：标准目录式技能；custom 同名技能优先
 * - Skill 可在自身目录放置 references/scripts/assets，Markdown 可通过 @include 引入补充文档
 *
 * 文件变更后只刷新缓存，下一轮 llmCall 自动用新提示词，不必重编译图。
 */
export class PromptManager {
    readonly agentsDir: string; // 根目录
    readonly promptPath: string; // 系统核心提示词路径
    private readonly builtinDir: string;
    private readonly customDir: string;
    private readonly debounceMs: number;
    private prompt: ResolvedMarkdown;
    private skills = new Map<string, AgentSkill>();
    private unwatch: UnwatchFn | null = null;
    private reloadTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly listeners = new Set<PromptReloadListener>();

    private constructor(
        prompt: ResolvedMarkdown,
        skills: Map<string, AgentSkill>,
        builtinDir: string,
        customDir: string,
        options: PromptManagerOptions,
    ) {
        this.agentsDir = options.agentsDir ?? AGENTS_DIR;
        this.promptPath = options.promptPath ?? DEFAULT_PROMPT_PATH;
        this.builtinDir = builtinDir;
        this.customDir = customDir;
        this.debounceMs = options.debounceMs ?? 200;
        this.prompt = prompt;
        this.skills = skills;
    }

    /** Tauri 文件 API 为异步接口，管理器必须通过此工厂完成首次加载。 */
    static async create(options: PromptManagerOptions = {}): Promise<PromptManager> {
        const agentsDir = options.agentsDir ?? AGENTS_DIR;
        const promptPath = options.promptPath ?? (options.agentsDir ? await join(agentsDir, "builtin", "default.md") : DEFAULT_PROMPT_PATH);
        const resolvedOptions = { ...options, agentsDir, promptPath };
        const prompt = await resolveMarkdownFile(promptPath, agentsDir);
        const manager = new PromptManager(
            prompt,
            new Map(),
            await join(agentsDir, "builtin"),
            await join(agentsDir, "custom"),
            resolvedOptions,
        );
        manager.skills = await manager.scanSkills();
        return manager;
    }

    /** default.md 展开 include 后的正文，不含技能目录；上下文面板的“系统提示词”按这项估算。 */
    getPromptBody(): string {
        return this.prompt.body;
    }

    /** 动态技能目录文本；上下文面板的“技能”分段和系统提示词拼装共用同一份。 */
    getSkillCatalog(): string {
        return this.formatSkillCatalog();
    }

    /** 系统提示词 = default.md（含 include）+ 动态技能目录。 */
    getSystemPrompt(): string {
        const catalog = this.getSkillCatalog();
        return catalog ? `${this.prompt.body}\n\n${catalog}` : this.prompt.body;
    }

    listSkills(): AgentSkill[] {
        return [...this.skills.values()];
    }

    getSkill(name: string): AgentSkill | undefined {
        return this.skills.get(name.trim().toLowerCase());
    }

    /** 供 load_skill/load_doc_body 使用：支持技能名、技能内资源路径或 agents 下的文档路径。 */
    async loadMarkdownBody(name: string, isSkill: boolean): Promise<string> {
        const spec = name.trim();
        if (isSkill) {
            const stem = spec.replace(/\.md$/i, "");
            const skill = this.getSkill(stem) ?? this.getSkill(await basename(stem)) ?? undefined;
            if (!skill) return `未找到技能或文档「${spec}」。补充文档可使用相对 agents/ 的路径；技能资源使用 <技能名>/references/foo.md。`;
            return `# 技能 ${skill.name}\n\n${skill.description}\n\n${skill.body}`;
        }
        try {
            const skillResource = await this.loadSkillResource(spec);
            if (skillResource) return skillResource;
            // 安装包资源位于 builtin，用户文档位于 custom；对模型继续暴露简洁的 docs/foo.md 写法。
            for (const baseDir of [this.agentsDir, this.builtinDir, this.customDir]) {
                const target = await resolveIncludePath(spec, baseDir, this.agentsDir);
                if (await exists(target)) {
                    return (await resolveMarkdownFile(target, this.agentsDir)).body;
                }
            }
        } catch {
            // 路径越界或解析失败时走下方统一错误，避免把本机路径细节暴露给模型。
        }
        const available =
            this.listSkills()
                .map((item) => item.name)
                .join("、") || "（无）";
        return `未找到技能或文档「${spec}」。可用技能: ${available}。补充文档可使用相对 agents/ 的路径；技能资源使用 <技能名>/references/foo.md。`;
    }

    onReload(listener: PromptReloadListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 先完整加载新提示词和技能，全部成功后再原子替换内存缓存。 */
    async reload(): Promise<boolean> {
        try {
            const prompt = await resolveMarkdownFile(this.promptPath, this.agentsDir);
            const skills = await this.scanSkills();
            this.prompt = prompt;
            this.skills = skills;
            for (const listener of this.listeners) listener();
            return true;
        } catch (error) {
            console.error("[langgraph-agent] 提示词/技能热重载失败，继续使用上一份:", error);
            return false;
        }
    }

    async startWatch(): Promise<void> {
        if (this.unwatch || !(await exists(this.agentsDir))) return;
        this.unwatch = await watch(
            this.agentsDir,
            (event) => {
                if (!event.paths.some((path) => path.toLowerCase().endsWith(".md"))) return;
                this.scheduleReload();
            },
            { recursive: true, delayMs: this.debounceMs },
        );
    }

    stopWatch(): void {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = null;
        }
        this.unwatch?.();
        this.unwatch = null;
    }

    dispose(): void {
        this.stopWatch();
        this.listeners.clear();
    }

    private async scanSkills(): Promise<Map<string, AgentSkill>> {
        const map = new Map<string, AgentSkill>();
        if (!(await exists(this.agentsDir))) return map;
        for (const dir of [this.builtinDir, this.customDir]) {
            const skillsDir = await join(dir, "skills");
            if (!(await exists(skillsDir))) continue;
            for (const entry of await readDir(skillsDir)) {
                // 标准 Skill 必须是独立目录，并以 SKILL.md 作为唯一入口；不再扫描扁平 .md 文件。
                if (!entry.isDirectory || entry.isSymlink) continue;
                const path = await join(skillsDir, entry.name, SKILL_ENTRY_FILE);
                if (!(await exists(path))) continue;
                try {
                    const resolved = await resolveMarkdownFile(path, this.agentsDir);
                    const name = resolved.meta.name?.trim();
                    const description = resolved.meta.description?.trim();
                    if (!name || !description) {
                        throw new Error("SKILL.md frontmatter 必须包含 name 和 description");
                    }
                    if (!isStandardSkillName(name)) {
                        throw new Error(`Skill 名称不符合标准格式: ${name}`);
                    }
                    if (name !== entry.name) {
                        throw new Error(`Skill 目录名必须与 frontmatter name 一致: ${entry.name} != ${name}`);
                    }
                    const skill: AgentSkill = {
                        name,
                        description,
                        path,
                        body: resolved.body,
                    };
                    // custom 后扫描，因此同名技能会覆盖 builtin，允许用户定制而不修改托管文件。
                    map.set(name.toLowerCase(), skill);
                } catch (error) {
                    console.error(`[langgraph-agent] 加载技能失败: ${entry.name}/SKILL.md`, error);
                }
            }
        }
        return map;
    }

    /**
     * 按 `<skill-name>/references/foo.md` 解析 Skill 的补充文档。
     * 资源路径始终以对应 SKILL.md 所在目录为边界起点，并继续受 agents 根目录越界校验保护。
     */
    private async loadSkillResource(spec: string): Promise<string | null> {
        const segments = spec.replace(/\\/g, "/").split("/").filter(Boolean);
        if (segments[0]?.toLowerCase() === "skills") segments.shift();
        const skill = this.getSkill(segments.shift() ?? "");
        if (!skill || segments.length === 0) return null;

        const skillDir = await dirname(skill.path);
        const target = await resolveIncludePath(segments.join("/"), skillDir, this.agentsDir);
        const resolvedSkillDir = await resolve(skillDir);
        const separator = sep();
        const skillBoundary = resolvedSkillDir.endsWith(separator) ? resolvedSkillDir : `${resolvedSkillDir}${separator}`;
        // Skill 资源只能留在自己的目录中；通用 agents 文档由下方独立路径分支读取。
        if (!target.startsWith(skillBoundary)) return null;
        if (!(await exists(target))) return null;
        return (await resolveMarkdownFile(target, this.agentsDir)).body;
    }

    private formatSkillCatalog(): string {
        const skills = this.listSkills();
        if (skills.length === 0) return "";
        const lines = skills.map((skill) => `- \`${skill.name}\`: ${skill.description}`);
        return [
            "## 可用技能",
            "",
            "遇到匹配的专项问题时，先调用 `load_skill` 加载完整说明，再按技能执行。未加载前不要凭记忆展开技能细节。",
            "",
            ...lines,
        ].join("\n");
    }

    private scheduleReload(): void {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            // 定时器回调不能 await，reload 自己会捕获并记录加载错误。
            void this.reload();
        }, this.debounceMs);
    }
}
