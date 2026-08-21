import { join, homeDir, appDataDir } from "@tauri-apps/api/path";

/**
 * 与主应用 localstore 一致，固定写到用户缓存目录。
 * macOS / Linux: ~/.cache/keray_shell
 */
export const KERAY_SHELL_CACHE_DIR = await join(await homeDir(), ".cache", "keray_shell");

/** 模型配置固定路径：~/.cache/keray_shell/model.json */
export const DEFAULT_CONFIG_PATH = await join(KERAY_SHELL_CACHE_DIR, "model.json");

/** Agent 全局运行时设置：访问限制与命令执行方式，对所有会话生效。 */
export const DEFAULT_AGENT_SETTINGS_PATH = await join(KERAY_SHELL_CACHE_DIR, "agent-settings.json");

/** Agent 提示词与技能文档目录 */
export const AGENTS_DIR = await join(await appDataDir(), "agents");

/** 应用随版本托管的内置提示词目录；由 Rust 启动逻辑同步。 */
export const BUILTIN_AGENTS_DIR = await join(AGENTS_DIR, "builtin");

/** 用户可自行维护、升级时不会被覆盖的提示词目录。 */
export const CUSTOM_AGENTS_DIR = await join(AGENTS_DIR, "custom");

/** 默认系统提示词文档位于应用托管目录。 */
export const DEFAULT_PROMPT_PATH = await join(BUILTIN_AGENTS_DIR, "default.md");
