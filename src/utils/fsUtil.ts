import { execRemote, invoke, utf8ToBase64 } from "@/utils/project";
import { Channel } from "@tauri-apps/api/core";
import dayjs from "dayjs";

/** 远程文件系统条目：目录树与列表共用同一模型；树节点仅为 is_dir 的子集视图 */
export type RemoteFileItem = {
    id: string; // 文件绝对路径
    parentId: string; // 父级绝对路径
    level: number;
    children: RemoteFileItem[] | null; // null表示文件夹未加载 文件时无意义
    parent: RemoteFileItem | null;
    leaf: boolean;

    size: number | null; // 文件大小
    isDir: boolean; // 是否是目录
    linkPath: string | null; // 如果是符号链接，则为目标路径
    updatedAt: number | null; // 更新时间 秒级时间戳
    permissions: number; // 权限
    owner: string; // 所有者
    group: string; // 所属组
    toJSON: () => RemoteFileItem;
};

/** 列出远端目录下的一级文件和子目录，不递归 */
export async function listRemoteSubFiles(serverId: string, absPath: string): Promise<RemoteFileItem[]> {
    const ppath = absPath === "/" ? absPath : `${absPath}/`;
    const shell = `for item in ${ppath}* ${ppath}.*; do
    if [ -L "$item" ]; then
      ls -ald "\$item" --time-style=+'%Y/%m/%d %H:%M'
      link=\`readlink -f $item\`;
      if [[ $link =~ ^/ ]]; then
        ls -ald $link --time-style=+'%Y/%m/%d %H:%M'
      else
        ls -ald $ppath$link --time-style=+'%Y/%m/%d %H:%M'
      fi
    else
      ls -ald "$item" --time-style=+'%Y/%m/%d %H:%M'
    fi
  done`;
    const raw = await execRemote(serverId, shell);
    const lines = raw
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    const items: RemoteFileItem[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const next = lines[i + 1];
        const item = parseRemoteSubFile(line, next);
        if (item?.id.endsWith("/.") || item?.id.endsWith("/..")) continue;
        if (item) {
            items.push(item);
        }
        if (item?.linkPath) i++;
    }
    return items;
}

/** 获取单个文件的远程文件信息 */
export async function oneFileRemoteItem(serverId: string, path: string): Promise<RemoteFileItem | null> {
    const ppath = path === "/" ? path : `${path}/`;
    const shell = `
    if [ -L "${path}" ]; then
      ls -ald "${path}" --time-style=+'%Y/%m/%d %H:%M'
      link=\`readlink -f ${path}\`;
      if [[ $link =~ ^/ ]]; then
        ls -ald $link --time-style=+'%Y/%m/%d %H:%M'
      else
        ls -ald ${ppath}$link --time-style=+'%Y/%m/%d %H:%M'
      fi
    else
      ls -ald "${path}" --time-style=+'%Y/%m/%d %H:%M'
    fi
    `;
    const raw = await execRemote(serverId, shell);
    console.log("oneFileRemoteItem:", serverId, shell, raw);
    const lines = raw
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    return parseRemoteSubFile(lines[0], lines[1]);
}

/**
 * 返回对应路径的文件信息。如果是文件夹时需要递归获取所有子文件和文件夹的信息
 */
export async function scanRemoteTree(serverId: string, path: string): Promise<RemoteFileItem> {
    const cmd = buildRemoteScanCmd(path, {
        requireDir: false,
        includeRoot: true,
        recursive: true,
        resolveLinkAbs: false,
        notFoundMessage: "路径不存在",
    });
    const rows = parseRemoteScanRows(await execRemote(serverId, cmd));
    return treeList2Tree(rows)[0]!;
}

/** 解析 SSH 会话实际用户的主目录（getent / passwd，回退 tilde） */
export async function resolveRemoteHome(serverId: string): Promise<string> {
    const cmd =
        'h=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6); ' +
        '[ -n "$h" ] || h=$(awk -F: -v u="$(id -u)" \'$3==u{print $6;exit}\' /etc/passwd 2>/dev/null); ' +
        '[ -n "$h" ] || h=$(eval echo "~$(id -un)"); ' +
        "printf '%s\\n' \"${h:-/}\"";
    const out = await execRemote(serverId, cmd);
    return out.trim() || "/";
}

/**
 * 流式读取远端文件 不支持暂停和取消
 * @param server - 服务器信息
 * @param remotePath - 远端文件路径
 * @param offset - 起始字节（0 开始）
 * @param onChunk - 回调函数，每次收到一个字节块时调用
 */
export async function sftpReadFileStream(serverId: string, path: string, offset: number, onChunk: (chunk: Uint8Array) => void): Promise<void> {
    function channelChunkToBytes(chunk: unknown): Uint8Array {
        if (chunk instanceof Uint8Array) return chunk;
        if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
        if (Array.isArray(chunk)) return new Uint8Array(chunk);
        if (chunk && typeof chunk === "object" && "buffer" in chunk && chunk.buffer instanceof ArrayBuffer) {
            const u = chunk as ArrayBufferView;
            return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
        }
        return new Uint8Array();
    }
    const stream = new Channel<Uint8Array>();
    stream.onmessage = (message) => {
        const bytes = channelChunkToBytes(message);
        onChunk(bytes);
    };
    await invoke("sftp_read", { serverId, path, offset, stream });
}

// 本地文件写入到远程文件 不支持暂停和取消
/**
 * 本地文件写入到远程文件 不支持暂停和取消
 * @param server - 服务器信息
 * @param remotePath - 远端文件路径
 * @param localPath - 本地文件路径
 */
export async function writeLocalFileToRemote(serverId: string, remotePath: string, localPath: string, callback?: (process: number) => void) {
    // 创建一个临时文件
    const tempPath = `${remotePath}_bak`;
    try {
        const stream = new Channel<number>();
        stream.onmessage = (process) => {
            callback?.(process);
        };
        await invoke("sftp_upload_local_file", { serverId, remotePath: tempPath, localPath, stream });
        // 重命名临时文件为原文件
        await remoteRename(serverId, tempPath, remotePath);
    } catch (error) {
        throw error;
    }
}

/** 获取父目录 */
export function parentDirSlash(p: string): string {
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "";
}

/** 获取路径的所有父路径 linux系统  只支持绝对路径 */
export function pathAllParentPaths(path: string): string[] {
    const parentPaths = ["/"];
    const ns = path.split("/");
    for (let i = 1; i < ns.length; i++) {
        parentPaths.push(ns.slice(0, i + 1).join("/"));
    }
    return parentPaths;
}

/** 获取文件名 */
export function baseName(p: string): string {
    if (p === "/") return "/";
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
}

/** 检查文件名是否符合 Linux 文件系统命名规则 */
export function checkLinuxFileName(name: string): boolean {
    return /^[^\0\/]+$/.test(name);
}

/** 拼接远程路径 */
export async function remoteJoin(...paths: string[]): Promise<string> {
    return paths.join("/");
}

/** 创建远程目录 */
export async function remoteMkdir(serverId: string, path: string) {
    await execRemote(serverId, `mkdir -p ${shellSingleQuote(path)}`);
}

/** 创建远程文件 */
export async function remoteCreateFile(serverId: string, path: string) {
    await execRemote(serverId, `touch ${shellSingleQuote(path)}`);
}

/** 删除远程文件 */
export async function remoteRemove(serverId: string, path: string) {
    if (!path) throw new Error("路径不能为空");
    if (path === "/" || path === "/*" || path === "//") throw new Error("根目录不能删除");
    if (!path.startsWith("/")) throw new Error("只允许删除绝对路径的文件");
    await execRemote(serverId, `rm -rf ${shellSingleQuote(path)}`);
}

/** 重命名远程文件 */
export async function remoteRename(serverId: string, oldPath: string, newPath: string) {
    await execRemote(serverId, `mv ${shellSingleQuote(oldPath)} ${shellSingleQuote(newPath)}`);
}

/** 移动远程文件 */
export async function remoteMove(serverId: string, oldPath: string, newPath: string) {
    await remoteRename(serverId, oldPath, newPath);
}

/** 复制远程文件 */
export async function remoteCopy(serverId: string, oldPath: string, newPath: string) {
    await execRemote(serverId, `cp -r ${shellSingleQuote(oldPath)} ${shellSingleQuote(newPath)}`);
}

type RemoteScanOptions = {
    requireDir: boolean; // 是否要求必须是目录，否则返回错误
    includeRoot: boolean; // 是否包含根目录
    recursive: boolean; // 是否递归
    resolveLinkAbs: boolean; // 是否解析符号链接的绝对路径
    notFoundMessage: string; // 未找到目录时的错误消息
};

function buildRemoteScanCmd(absPath: string, opts: RemoteScanOptions): string {
    const testExpr = opts.requireDir ? "-d" : "-e";
    const linkCmd = opts.resolveLinkAbs ? `readlink -f "$fp" 2>/dev/null || realpath "$fp" 2>/dev/null || readlink "$fp" 2>/dev/null || true` : `readlink "$fp" 2>/dev/null || true`;
    const findDepth = opts.recursive ? `-mindepth 1` : `-mindepth 1 -maxdepth 1`;
    function decodePathCmd(absPath: string): string {
        const pathB64 = utf8ToBase64(absPath);
        return `p=$(printf '%s' '${pathB64}' | (base64 -d 2>/dev/null || base64 -D 2>/dev/null))`;
    }
    const lines = [
        "set -eu",
        decodePathCmd(absPath),
        `if ! test ${testExpr} "$p"; then printf '__ERR__\\t%s\\n' "${opts.notFoundMessage}"; exit 0; fi`,
        `if stat -c %Y / >/dev/null 2>&1; then STATGNU=1; else STATGNU=0; fi`,
        `enc() { printf '%s' "$1" | (base64 | tr -d '\\n'); }`,
        `emit() {`,
        `  fp="$1"`,
        `  [ -L "$fp" ] && islnk=1 || islnk=0`,
        `  [ -d "$fp" ] && isdir=1 || isdir=0`,
        `  if [ "$STATGNU" = 1 ]; then`,
        `    st=$(stat -c '%s\t%Y\t%A\t%U\t%G' "$fp" 2>/dev/null) || st=''`,
        `  else`,
        `    st=$(stat -f '%z\t%m\t%Sp\t%Su\t%Sg' "$fp" 2>/dev/null) || st=''`,
        `  fi`,
        `  if [ -n "$st" ]; then`,
        `    IFS=$'\\t' read -r sz mt perm own grp <<<"$st"`,
        `  else`,
        `    sz='-'; mt='-'; perm='?'; own='?'; grp='?'`,
        `  fi`,
        `  [ "$isdir" = 1 ] && sz='-'`,
        `  link='-'`,
        `  if [ "$islnk" = 1 ]; then`,
        `    link=$(${linkCmd})`,
        `  fi`,
        `  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(enc "$fp")" "$isdir" "$islnk" "$sz" "$mt" "$perm" "$own" "$grp" "$(enc "$link")"`,
        `}`,
    ];
    if (opts.includeRoot) lines.push(`emit "$p"`);
    lines.push(`if [ -d "$p" ]; then`, `  while IFS= read -r -d '' fp; do`, `    emit "$fp"`, `  done < <(find "$p" ${findDepth} -print0 2>/dev/null || true)`, `fi`);
    return lines.join("\n");
}

function parseRemoteScanRows(raw: string): RemoteFileItem[] {
    /** 解析错误行 */
    function parseErrorLine(line: string): string | null {
        if (!line.startsWith("__ERR__\t")) return null;
        return line.slice("__ERR__\t".length).trim() || "远端执行失败";
    }
    /** 解析可为空整数 */
    function parseNullableInt(v: string): number | null {
        if (!v || v === "-") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    const lines = raw
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    if (lines.length === 0) return [];
    const headErr = parseErrorLine(lines[0]);
    if (headErr) throw new Error(headErr);
    const rows: RemoteFileItem[] = [];
    for (const line of lines) {
        const lineErr = parseErrorLine(line);
        if (lineErr) throw new Error(lineErr);
        const [pathB64, isDir, isLnk, size, mtime, perm, owner, group, linkB64] = line.split("\t");
        if (!group) continue;
        const path = base64ToUtf8(pathB64);
        rows.push({
            id: path,
            parentId: parentDirSlash(path),
            level: 0,
            children: null,
            parent: null,
            leaf: true,
            size: parseNullableInt(size),
            isDir: isDir === "1",
            linkPath: isLnk === "1" ? base64ToUtf8(linkB64 || "") : null,
            updatedAt: parseNullableInt(mtime),
            permissions: toPermBits(perm),
            owner: owner || "?",
            group: group || "?",
            toJSON: function () {
                return {
                    ...this,
                    parent: null,
                };
            },
        });
    }
    // 默认按文件名排序
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
}

function parseRemoteSubFile(line: string, next?: string): RemoteFileItem | null {
    // id: string; // 文件绝对路径
    // parentId: string; // 父级绝对路径
    // level: number;
    // children: RemoteFileItem[] | null; // null表示文件夹未加载 文件时无意义
    // parent: RemoteFileItem | null;
    // leaf: boolean;

    // size: number | null; // 文件大小
    // isDir: boolean; // 是否是目录
    // linkPath: string | null; // 如果是符号链接，则为目标路径
    // updatedAt: number | null; // 更新时间 秒级时间戳
    // permissions: number; // 权限
    // owner: string; // 所有者
    // group: string; // 所属组
    // -rw-r--r-- 1 root root 3175677 2026/05/21 15:47 /root/人才引进报告.pdf Copy
    // lrwxrwxrwx 1 root root 9 2023/03/15 06:41 /lib32 -> usr/lib32

    const ls = line.split(RegExp(" "));
    if (ls.length < 8 || line.includes("cannot access")) return null;
    const isLink = ls[0].startsWith("l");
    let path = "";
    let linkPath = "";
    if (isLink) {
        let index = 0;
        for (let i = 8; i < ls.length; i++) {
            if (ls[i] === "->") {
                index = i;
                break;
            }
        }
        path = ls.slice(7, index).join(" ");
        linkPath = ls.slice(index + 1).join(" ");
    } else {
        path = ls.slice(7).join(" ");
    }
    const type = ls[0].substring(0, 1);
    const isFile = type === "-" || type === "l-";
    const parentPath = parentDirSlash(path);
    const item: RemoteFileItem = {
        id: path,
        parentId: parentPath,
        level: 0,
        children: null,
        parent: null,
        leaf: false,
        size: isFile ? parseInt(ls[4]) : null,
        isDir: !isFile,
        linkPath: null,
        updatedAt: dayjs(`${ls[5]} ${ls[6]}`, "YYYY/MM/DD HH:mm").toDate().getTime() / 1000,
        permissions: toPermBits(ls[0]),
        owner: ls[2],
        group: ls[3],
        toJSON: function () {
            return {
                ...this,
                parent: null,
            };
        },
    };
    // 如果是符号链接，则获取目标路径
    if (isLink) {
        const linkPath = ls[9];
        if (linkPath.startsWith("/")) {
            item.linkPath = linkPath;
        } else {
            item.linkPath = `${parentPath}${linkPath}`;
        }
        if (next) {
            const nextItem = parseRemoteSubFile(next!);
            item.size = nextItem?.size ?? null;
        }
    }
    return item;
}

/** 将权限字符串转换为权限位 */
function toPermBits(perm: string): number {
    const p = (perm || "").trim();
    if (p.length < 10) return 0;
    const rwx = p.slice(-9);
    const triads = [rwx.slice(0, 3), rwx.slice(3, 6), rwx.slice(6, 9)];
    const triadToBits = (s: string) => (s[0] === "r" ? 4 : 0) + (s[1] === "w" ? 2 : 0) + (s[2] !== "-" ? 1 : 0);
    return triadToBits(triads[0]) * 64 + triadToBits(triads[1]) * 8 + triadToBits(triads[2]);
}
