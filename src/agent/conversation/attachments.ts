import { join } from "@tauri-apps/api/path";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { type AgentInputMessage, isAgentImageAttachment, mimeFromFileName, type AgentAttachment, type AgentChatMessage } from "@/agent/types";
import { removeLocalIfAny } from "@/utils/localFsUtils";

/** 会话附件副本目录：~/.cache/keray_shell/conversation/temp。 */
export const CONVERSATION_TEMP_SEGMENTS = ["conversation", "temp"] as const;

function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInside(filePath: string, dir: string): boolean {
    const file = normalizePath(filePath);
    const root = normalizePath(dir);
    return file === root || file.startsWith(`${root}/`);
}

/** 去掉路径分隔符和 Windows 非法文件名字符，避免拼进 cache 后无法落盘。 */
function safeFileName(name: string): string {
    const base = name.split(/[\\/]/).at(-1)?.trim() || "attachment";
    return base.replace(/[<>:"|?*\u0000-\u001f]/g, "_") || "attachment";
}

async function conversationTempDir(): Promise<string> {
    return await useLocalStore().ensureCacheDir(...CONVERSATION_TEMP_SEGMENTS);
}

export async function isConversationTempPath(path: string): Promise<boolean> {
    return isPathInside(path, await conversationTempDir());
}

/** 把任意本地文件拷进会话 temp 目录；源已在该目录时直接复用。 */
export async function copyToConversationTemp(sourcePath: string, originalName: string): Promise<{ path: string; size: number }> {
    const dir = await conversationTempDir();
    if (isPathInside(sourcePath, dir)) {
        const bytes = await readFile(sourcePath);
        return { path: sourcePath, size: bytes.length };
    }
    const bytes = await readFile(sourcePath);
    return await writeBytesToConversationTemp(bytes, originalName);
}

/** 粘贴得到的二进制直接写入会话 temp，不再走系统 /tmp。 */
export async function writeBytesToConversationTemp(bytes: Uint8Array, originalName: string): Promise<{ path: string; size: number }> {
    const dest = await join(await conversationTempDir(), `${uuid()}_${safeFileName(originalName)}`);
    await writeFile(dest, bytes, { create: true });
    return { path: dest, size: bytes.length };
}

/**
 * 落盘前保证附件路径已经是会话 temp 副本。
 * 成功时回写原对象，避免下次 persist 再拷一份。
 */
export async function ensureConversationTempCopy(file: AgentAttachment): Promise<AgentAttachment> {
    if (await isConversationTempPath(file.path)) return file;
    try {
        const copied = await copyToConversationTemp(file.path, file.name);
        file.path = copied.path;
        file.size = copied.size;
        return file;
    } catch {
        // 源文件可能已被移动；仍写出原路径，避免整份会话落盘失败。
        return file;
    }
}

/** 释放 blob 预览，避免切会话或删附件后地址一直占着内存。 */
export function revokeAttachmentPreview(file: Pick<AgentAttachment, "previewUrl">): void {
    if (!file.previewUrl?.startsWith("blob:")) return;
    URL.revokeObjectURL(file.previewUrl);
    file.previewUrl = undefined;
}

/**
 * 从磁盘副本重新生成图片预览。
 * blob: URL 不能落盘，重新加载后必须按 path 读字节再建一次。
 */
export async function hydrateAttachmentPreview(file: AgentAttachment): Promise<void> {
    if (file.previewUrl || !isAgentImageAttachment(file)) return;
    try {
        const bytes = await readFile(file.path);
        if (!bytes.length) return;
        const mime = file.mimeType || mimeFromFileName(file.name) || "image/png";
        file.previewUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } catch {
        // 副本可能已被清掉；没有 previewUrl 时气泡只显示文件名。
    }
}

/** 读出会话 JSON 后补齐附件预览，给历史气泡和输入区用。 */
export async function hydrateConversationPreviews(messages: AgentInputMessage[]): Promise<void> {
    await Promise.all(messages.flatMap((message) => (message.attachments ?? []).map((file) => hydrateAttachmentPreview(file))));
}

/** 丢掉内存里的会话前先释放预览，避免 blob: URL 泄漏。 */
export function revokeConversationPreviews(messages: AgentInputMessage[]): void {
    for (const message of messages) {
        for (const file of message.attachments ?? []) revokeAttachmentPreview(file);
    }
}

/** 输入区移除未发送附件，或卸载时丢掉还没进会话记录的 temp 文件。 */
export async function discardConversationTempAttachment(file: Pick<AgentAttachment, "path" | "previewUrl">): Promise<void> {
    revokeAttachmentPreview(file);
    if (await isConversationTempPath(file.path)) await removeLocalIfAny(file.path);
}

/** 删除会话记录时，只清该记录引用过的 temp 副本，不动用户原文件。 */
export async function removeConversationTempFiles(messages: AgentInputMessage[]): Promise<void> {
    for (const message of messages) {
        for (const file of message.attachments ?? []) {
            revokeAttachmentPreview(file);
            if (await isConversationTempPath(file.path)) await removeLocalIfAny(file.path);
        }
    }
}
