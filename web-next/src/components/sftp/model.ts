import { treeForEach, treeForEachAsync } from "@/utils";
import type { TransferItem } from "@/stores/downloadStore";
import { baseName, checkLinuxFileName, listRemoteSubFiles, parentDirSlash, remoteCreateFile, remoteJoin, remoteMkdir, remoteRemove, remoteRename, type RemoteFileItem } from "@/utils/fsUtil";
import { execRemote, shellSingleQuote } from "@/utils/project";
import { showToast } from "@/utils/ui";

export type FileStoreItem = RemoteFileItem & {
    loading?: boolean;
    open?: boolean;
    children: FileStoreItem[] | null;
    parent: FileStoreItem | null;
};

export type TransferUiItem = TransferItem & {
    open?: boolean;
};

function attachTreeJson(item: FileStoreItem): FileStoreItem {
    item.toJSON = function toJSON() {
        return {
            ...this,
            parent: null,
        };
    };
    return item;
}

export function createDirItem(id: string, parent: FileStoreItem | null, level: number): FileStoreItem {
    return attachTreeJson({
        id,
        parentId: parent?.id ?? "",
        level,
        children: null,
        parent,
        leaf: true,
        size: null,
        isDir: true,
        linkPath: null,
        updatedAt: null,
        permissions: 0,
        owner: "",
        group: "",
        toJSON() {
            return this;
        },
    });
}

export function createRootFile(): FileStoreItem {
    return createDirItem("/", null, 0);
}

export function findTreeItem(root: FileStoreItem, id: string): FileStoreItem | null {
    let found: FileStoreItem | null = null;
    treeForEach<FileStoreItem>(root, (item) => {
        if (item.id !== id) return false;
        found = item;
        return true;
    });
    return found;
}

/** 修改文件名 */
export async function changeFileItemName(serverId: string, fileItem: FileStoreItem, newName: string): Promise<string> {
    if (!checkLinuxFileName(newName)) {
        return fileItem.id;
    }
    const oldPath = fileItem.id;
    const newPath = await remoteJoin(parentDirSlash(fileItem.id), newName);
    fileItem.id = newPath;
    fileItem.parentId = parentDirSlash(newPath) || "/";
    // 和 Vue 版一致：目录重命名后，已加载子树的绝对路径必须同步，否则后续操作会继续指向旧路径。
    await treeForEachAsync(fileItem.children ?? [], async (item) => {
        item.id = await remoteJoin(fileItem.id, baseName(item.id));
        item.parentId = fileItem.id;
    });
    await remoteRename(serverId, oldPath, fileItem.id).catch((err) => {
        console.error(err);
        showToast("文件名修改失败", "error");
    });
    return newPath;
}

/** 加载目录 */
export async function loadDirectory(serverId: string, parent: FileStoreItem, force = false): Promise<void> {
    if (parent.children !== null && !force) {
        return;
    }
    parent.loading = true;
    const children = await listRemoteSubFiles(serverId, parent.id);
    parent.children = children;
    parent.children.forEach((item) => {
        item.level = parent.level + 1;
        item.parent = parent;
    });
    parent.leaf = parent.children.length === 0;
    parent.loading = false;
}

/** 添加文件 */
export async function addFileItem(serverId: string, parent: FileStoreItem, newName: string, isDir = true): Promise<string> {
    if (!checkLinuxFileName(newName)) {
        showToast("文件名不符合 Linux 文件系统命名规则", "error");
        return "";
    }
    const newPath = await remoteJoin(parent.id, newName);
    if (isDir) await remoteMkdir(serverId, newPath);
    else await remoteCreateFile(serverId, newPath);
    await loadDirectory(serverId, parent, true);
    return newPath;
}

/** 删除文件 */
export async function deleteFileItem(serverId: string, fileItem: FileStoreItem): Promise<void> {
    await remoteRemove(serverId, fileItem.id);
    fileItem.parent?.children?.remove(fileItem);
}

/** 修改文件权限 */
export async function changeFileItemPermissions(serverId: string, fileItem: FileStoreItem, permBits: number): Promise<void> {
    const octal = (permBits & 0o777).toString(8).padStart(3, "0");
    await execRemote(serverId, `chmod ${octal} ${shellSingleQuote(fileItem.id)}`);
    fileItem.permissions = permBits & 0o777;
}

export function compareNameLikeExplorer(a: string, b: string): number {
    const ah = a.startsWith(".");
    const bh = b.startsWith(".");
    if (ah !== bh) return ah ? -1 : 1;
    return a.localeCompare(b);
}
