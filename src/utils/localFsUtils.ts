import { type } from "@tauri-apps/plugin-os";
import { open } from "@tauri-apps/plugin-dialog";
import { remove, stat } from "@tauri-apps/plugin-fs";

/* 将linux路径转换为本地路径 */
export function linuxPathToLocalPath(path: string): string {
    // 如果是win系统，则将路径中的/替换为\
    if (type() === "windows") {
        return path.replace(/\//g, "\\");
    }
    return path;
}

/* 将本地路径转换为linux路径 */
export function localPathToLinuxPath(path: string): string {
    if (type() === "windows") {
        return path.replace(/\//g, "\\");
    }
    return path;
}

/* 获取文件的目录路径 */
export function getFileDirPath(path: string): string {
    const linuxPath = localPathToLinuxPath(path);
    return linuxPathToLocalPath(linuxPath.split("/").slice(0, -1).join("/"));
}

/** 读取本地文件字节数 */
export async function localFileByteSize(absolutePath: string): Promise<number | null> {
    try {
        const st = await stat(absolutePath);
        if (!st.isFile) return null;
        return st.size;
    } catch {
        return null;
    }
}

/** 删除本地文件 */
export async function removeLocalIfAny(localPath: string) {
    try {
        await remove(localPath);
    } catch {
        // 不存在等忽略
    }
}
