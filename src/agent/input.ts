import { readFile, stat } from "@tauri-apps/plugin-fs";
import { isAgentImageAttachment, type AgentAttachment, type AgentInputMessage } from "@/agent/types";
import { estimateDraftConversationTokens, estimateTokens } from "./context";

const MAX_INLINE_FILE_BYTES = 256 * 1024;
/** 视觉请求里的图片上限，与输入区粘贴限制一致。 */
const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
/** 图片 token 与分辨率和具体网关有关；发送前只做保守占位，真实值由 usage_metadata 覆盖展示。 */
const ESTIMATED_VISION_IMAGE_TOKENS = 1_024;

type AgentTextPart = { type: "text"; text: string };
type AgentImagePart = { type: "image_url"; image_url: { url: string } };

export type AgentModelInput = string | Array<AgentTextPart | AgentImagePart>;

export type AgentPromptSubmitOptions = Pick<AgentInputMessage, "attachments" | "content" | "skillNames">;

/** 显式选择技能只发送加载指令，技能正文要等 load_skill 的 ToolMessage 才进入上下文。 */
export function selectedSkillsInstruction(skillNames: string[]): string {
    if (skillNames.length === 0) return "";
    return `## 本轮选用技能\n\n用户已显式选择：${skillNames.join("、")}。开始处理前请逐一调用 load_skill 加载这些技能。`;
}

/**
 * 把用户文本、技能选择、本地文本文件和图片组装进本轮真实 HumanMessage。
 * 发送和预估共用下面的附件准备函数，确保大文件/二进制分支不会出现两套口径。
 */
export async function buildAgentInput(options: AgentPromptSubmitOptions): Promise<AgentModelInput> {
    const sections = options.content ? [options.content] : [];
    const skillInstruction = selectedSkillsInstruction(options.skillNames ?? []);
    if (skillInstruction) sections.push(skillInstruction);

    const imageAttachments = options.attachments?.filter(isAgentImageAttachment) ?? [];
    const fileAttachments = options.attachments?.filter((item) => !isAgentImageAttachment(item)) ?? [];
    if (fileAttachments.length > 0) {
        const fileSections = await Promise.all(fileAttachments.map(prepareFileAttachment));
        sections.push(`## 本地附件\n\n${fileSections.join("\n\n")}`);
    }

    // 只有图片没有文字时补一句，避免部分兼容网关拒绝空 text 块。
    const text = sections.join("\n\n") || "请查看用户提供的图片。";
    if (imageAttachments.length === 0) return text;

    const imageParts = await Promise.all(imageAttachments.map(prepareImageAttachment));
    return [{ type: "text", text }, ...imageParts];
}

/**
 * 估算输入框和尚未提交的技能和附件占用。
 */
export async function estimateInputTokens({ content, attachments, skillNames }: AgentPromptSubmitOptions): Promise<number> {
    const tokens = await estimatePromptOptionTokens(
        {
            attachments: [...(attachments ?? [])],
            skillNames: [...(skillNames ?? [])],
        },
        Boolean(content.trim()),
    );
    const contentTokens = estimateDraftConversationTokens(content.trim());
    return tokens + contentTokens;
}

/**
 * 估算输入框之外、尚未提交的技能和附件占用。
 * 文本附件走与发送完全相同的读取分支；可内联图片使用固定占位，避免把 base64 字符数误当文本 token。
 */
export async function estimatePromptOptionTokens(
    options: Omit<AgentPromptSubmitOptions, "content">,
    hasQuestion: boolean,
): Promise<number> {
    const sections: string[] = [];
    const skillInstruction = selectedSkillsInstruction(options.skillNames ?? []);
    if (skillInstruction) sections.push(skillInstruction);

    const imageAttachments = options.attachments?.filter(isAgentImageAttachment) ?? [];
    const fileAttachments = options.attachments?.filter((item) => !isAgentImageAttachment(item)) ?? [];
    if (fileAttachments.length > 0) {
        const fileSections = await Promise.all(fileAttachments.map(prepareFileAttachment));
        sections.push(`## 本地附件\n\n${fileSections.join("\n\n")}`);
    }

    let tokens = estimateTokens(sections.join("\n\n"));
    if (!hasQuestion && sections.length === 0 && imageAttachments.length > 0) tokens += estimateTokens("请查看用户提供的图片。");
    for (const attachment of imageAttachments) tokens += await estimateImageAttachmentTokens(attachment);
    return tokens;
}

async function prepareFileAttachment(attachment: AgentAttachment): Promise<string> {
    try {
        const metadata = await stat(attachment.path);
        if (metadata.size > MAX_INLINE_FILE_BYTES) {
            return `<local_file name="${attachment.name}" path="${attachment.path}">文件大小 ${metadata.size} 字节，超过 ${MAX_INLINE_FILE_BYTES} 字节内联上限；本轮仅提供路径和元信息。</local_file>`;
        }
        const bytes = await readFile(attachment.path);
        // NUL 通常表示二进制内容；不强行解码可避免向模型传入损坏文本。
        if (bytes.some((byte) => byte === 0)) {
            return `<local_file name="${attachment.name}" path="${attachment.path}">二进制文件，本轮仅提供路径和元信息。</local_file>`;
        }
        const content = new TextDecoder().decode(bytes);
        return `<local_file name="${attachment.name}" path="${attachment.path}">\n${content}\n</local_file>`;
    } catch (error) {
        return `<local_file name="${attachment.name}" path="${attachment.path}">读取失败：${getErrorMessage(error)}</local_file>`;
    }
}

/** 把本地图片编成 data URL；失败时退回文字说明，避免整轮提交被单张坏图打断。 */
async function prepareImageAttachment(attachment: AgentAttachment): Promise<AgentImagePart | AgentTextPart> {
    try {
        const metadata = await stat(attachment.path);
        if (metadata.size > MAX_VISION_IMAGE_BYTES) {
            return {
                type: "text",
                text: oversizedImageMessage(attachment, metadata.size),
            };
        }
        const bytes = await readFile(attachment.path);
        const mime = attachment.mimeType || "image/png";
        return { type: "image_url", image_url: { url: `data:${mime};base64,${uint8ToBase64(bytes)}` } };
    } catch (error) {
        return { type: "text", text: imageReadErrorMessage(attachment, error) };
    }
}

/** 图片无法内联时统计实际发送的文字；成功内联时使用模型无关的保守占位。 */
async function estimateImageAttachmentTokens(attachment: AgentAttachment): Promise<number> {
    try {
        const metadata = await stat(attachment.path);
        return metadata.size > MAX_VISION_IMAGE_BYTES
            ? estimateTokens(oversizedImageMessage(attachment, metadata.size))
            : ESTIMATED_VISION_IMAGE_TOKENS;
    } catch (error) {
        return estimateTokens(imageReadErrorMessage(attachment, error));
    }
}

function oversizedImageMessage(attachment: AgentAttachment, size: number): string {
    return `<local_file name="${attachment.name}" path="${attachment.path}">图片大小 ${size} 字节，超过 ${MAX_VISION_IMAGE_BYTES} 字节上限，本轮仅提供路径。</local_file>`;
}

function imageReadErrorMessage(attachment: AgentAttachment, error: unknown): string {
    return `<local_file name="${attachment.name}" path="${attachment.path}">图片读取失败：${getErrorMessage(error)}</local_file>`;
}

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = "";
    // 分块展开，避免大图一次性 spread 撑爆调用栈。
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
