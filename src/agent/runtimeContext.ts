import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { dirname } from "@tauri-apps/api/path";
import { reactive } from "vue";
import { z } from "zod";
import { DEFAULT_AGENT_SETTINGS_PATH } from "./paths";

/**
 * 访问限制与 agents/docs/safety-and-authorization.md 的风险分级对齐：
 * - ask：R1 询问（自动 R0，R1/R2/R3 都问）
 * - safe：R2 询问（自动 R0/R1，R2/R3 都问）
 * - auto：高度自主 / R3 询问（自动 R0/R1/R2，只问 R3）
 * - full：完全访问（自动执行 R1/R2/R3）
 * R4 禁止项在任何模式下都不可执行。
 */
export const AgentAccessModeSchema = z.enum(["ask", "safe", "auto", "full"]);
export type AgentAccessMode = z.infer<typeof AgentAccessModeSchema>;

/**
 * 命令执行通道。
 * - silent：后台 exec，不写入用户终端
 * - visual：把命令打到当前终端，用户能看见执行过程
 */
export const AgentCommandExecutionSchema = z.enum(["silent", "visual"]);
export type AgentCommandExecution = z.infer<typeof AgentCommandExecutionSchema>;

export const AgentRuntimeContextSchema = z.object({
    accessMode: AgentAccessModeSchema.default("ask"),
    commandExecution: AgentCommandExecutionSchema.default("silent"),
});
export type AgentRuntimeContext = z.infer<typeof AgentRuntimeContextSchema>;

export const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeContext = {
    accessMode: "ask",
    commandExecution: "silent",
};

export type AccessModeTone = "default" | "warning" | "error";

export interface AccessModeConfirm {
    title: string;
    message: string;
    confirmText: string;
    danger?: boolean;
    warning?: boolean;
}

export const ACCESS_MODE_OPTIONS: {
    value: AgentAccessMode;
    label: string;
    shortLabel: string;
    description: string;
    icon: string;
    tone: AccessModeTone;
    confirm?: AccessModeConfirm;
}[] = [
    {
        value: "ask",
        label: "请求批准",
        shortLabel: "请求批准",
        description: "全盘扫描、抓包、改配置、重启或删除等，执行前都会询问",
        icon: "mdi:hand-back-left-outline",
        tone: "default",
    },
    {
        value: "safe",
        label: "帮我批准",
        shortLabel: "帮我批准",
        description: "排查观察可自动进行；改配置、重启、删除等会改动系统的操作仍会询问",
        icon: "mdi:console",
        tone: "default",
    },
    {
        value: "auto",
        label: "高度自主",
        shortLabel: "高度自主",
        description: "可自动做能回滚的配置变更；重启、杀进程、删除、改磁盘或防火墙仍会询问",
        icon: "mdi:shield-alert-outline",
        tone: "warning",
        confirm: {
            title: "开启高度自主？",
            message:
                "开启后，Agent 可以自行完成低负载只读排查，以及能回滚的配置变更，不再逐条询问。\n\n以下高影响操作仍会请求批准：停止/重启服务或主机、杀进程、删除、磁盘和文件系统写入、改网络/SSH/防火墙、改认证策略、批量改权限、动内核或引导、变更集群成员或数据库状态。\n\n无论何种授权都不会执行：泄露无关凭据、关闭审计或防护、销毁证据、目标未确认就跑破坏性命令、建立后门或反向 shell。",
            confirmText: "仍要开启",
            warning: true,
        },
    },
    {
        value: "full",
        label: "完全访问权限",
        shortLabel: "完全访问",
        description: "可自动执行重启、删除、改磁盘和网络等高影响操作，执行前不再询问",
        icon: "mdi:alert-octagon-outline",
        tone: "error",
        confirm: {
            title: "开启完全访问权限？",
            message:
                "开启后，Agent 可以自行执行高负载排查、可回滚变更，以及高影响操作（停止/重启、杀进程、删除、磁盘写入、改网络/SSH/防火墙、改认证与权限、动内核或数据库），执行前不再征求批准。风险极高。\n\n无论何种授权都不会执行：泄露无关凭据、关闭审计或防护、销毁证据、目标未确认就跑破坏性命令、建立后门或反向 shell。",
            confirmText: "仍要开启",
            danger: true,
        },
    },
];

/** 模块级响应式状态：所有会话、所有 AgentPanel 共用同一份。 */
const context = reactive<AgentRuntimeContext>({ ...DEFAULT_AGENT_RUNTIME_SETTINGS });
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

function parseContext(raw: unknown): AgentRuntimeContext {
    const parsed = AgentRuntimeContextSchema.safeParse(raw);
    return parsed.success ? { ...parsed.data } : { ...DEFAULT_AGENT_RUNTIME_SETTINGS };
}

async function persist(): Promise<void> {
    try {
        const path = DEFAULT_AGENT_SETTINGS_PATH;
        await mkdir(await dirname(path), { recursive: true });
        await writeTextFile(
            path,
            `${JSON.stringify({ accessMode: context.accessMode, commandExecution: context.commandExecution }, null, 4)}\n`,
            {
                create: true,
                createNew: false,
            },
        );
    } catch (error) {
        console.error("[langgraph-agent] 保存 Agent 运行时设置失败:", error);
    }
}

/** 启动时从磁盘恢复；失败则保留默认值，避免把输入区打挂。 */
export async function hydrateAgentRuntimeContext(): Promise<AgentRuntimeContext> {
    if (hydrated) return context;
    if (hydratePromise) {
        await hydratePromise;
        return context;
    }
    hydratePromise = (async () => {
        try {
            if (await exists(DEFAULT_AGENT_SETTINGS_PATH)) {
                const raw: unknown = JSON.parse(await readTextFile(DEFAULT_AGENT_SETTINGS_PATH));
                Object.assign(context, parseContext(raw));
            }
        } catch (error) {
            console.error("[langgraph-agent] 读取 Agent 运行时设置失败，使用默认值:", error);
        } finally {
            hydrated = true;
        }
    })();
    await hydratePromise;
    return context;
}

export function getAgentRuntimeContext(): AgentRuntimeContext {
    return context;
}

export async function setAgentAccessMode(value: AgentAccessMode): Promise<void> {
    if (context.accessMode === value) return;
    context.accessMode = value;
    await persist();
}

export async function setAgentCommandExecution(value: AgentCommandExecution): Promise<void> {
    if (context.commandExecution === value) return;
    context.commandExecution = value;
    await persist();
}

export function accessModeOption(value: AgentAccessMode = context.accessMode) {
    return ACCESS_MODE_OPTIONS.find((item) => item.value === value) ?? ACCESS_MODE_OPTIONS[0];
}
