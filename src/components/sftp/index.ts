import { remoteCreateFile, remoteJoin, remoteRemove, remoteRename } from "@/utils/fsUtil";

export type FileStoreItem = RemoteFileItem & {
    loading?: boolean;
    open?: boolean;
};

export type TransferUiItem = TransferItem & {
    open?: boolean;
};

/** 修改文件名 */
export async function changeFileItemName(serverId: string, fileItem: FileStoreItem, newName: string) {
    if (!checkLinuxFileName(newName)) {
        return;
    }
    const oldPath = fileItem.id;
    fileItem.id = await remoteJoin(parentDirSlash(fileItem.id), newName);
    // 修改下级所有节点的id和parentId
    await treeForEachAsync(fileItem.children ?? [], async (item) => {
        item.id = await remoteJoin(fileItem.id, baseName(item.id));
        item.parentId = fileItem.id;
    });
    // 远程修改路径
    await remoteRename(serverId, oldPath, fileItem.id).catch((err) => {
        showToast("文件名修改失败", "error");
    });
}

/** 加载目录 */
export async function loadDirectory(serverId: string, parent: FileStoreItem, force: boolean = false) {
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
export async function addFileItem(serverId: string, parent: FileStoreItem, newName: string, isDir: boolean = true): Promise<string> {
    if (!checkLinuxFileName(newName)) {
        showToast("文件名不符合 Linux 文件系统命名规则", "error");
        return "";
    }
    // 执行mkdir命令
    const newPath = await remoteJoin(parent.id, newName);
    if (isDir) {
        await remoteMkdir(serverId, newPath);
    } else {
        await remoteCreateFile(serverId, newPath);
    }
    // 强制重新加载父级目录
    await loadDirectory(serverId, parent, true);
    return newPath;
}

/** 删除文件 */
export async function deleteFileItem(serverId: string, fileItem: FileStoreItem) {
    await remoteRemove(serverId, fileItem.id);
    fileItem.parent?.children?.splice(fileItem.parent.children.indexOf(fileItem), 1);
}

/** 修改文件权限 */
export async function changeFileItemPermissions(serverId: string, fileItem: FileStoreItem, permBits: number) {
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
