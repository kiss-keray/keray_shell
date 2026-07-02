/** 规范化 POSIX 绝对路径 */
export function normalizePosixPath(path: string): string {
    if (!path) return "/";
    const absolute = path.startsWith("/");
    const parts = path.split("/").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
        if (part === ".") continue;
        if (part === "..") {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    const joined = stack.join("/");
    return absolute ? `/${joined}` : joined || ".";
}

/** 从终端输出中解析“当前工作目录”的候选路径（OSC 7 / OSC 0/2 title / 常见 prompt） */
export function parseOsc7Cwd(data: string, homeDir?: string): string[] {
    const paths: string[] = [];

    const pushPath = (p: string | null | undefined) => {
        if (!p) return;
        const raw = p.trim();
        const expanded = raw === "~" ? (homeDir ?? "") : raw.startsWith("~/") ? (homeDir ? `${homeDir}/${raw.slice(2)}` : "") : raw;
        const normalized = normalizePosixPath(expanded);
        if (!normalized.startsWith("/")) return; // homeDir 缺失时 "~" 会在这里被丢弃
        if (paths[paths.length - 1] === normalized) return;
        paths.push(normalized);
    };

    // OSC 7: ESC ] 7;file://host/path ST
    {
        const re = /\x1b\]7;file:\/\/(?:[^/\x07\x1b]*)(\/[^\x07\x1b]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(data)) !== null) {
            const raw = m[1];
            try {
                pushPath(decodeURIComponent(raw));
            } catch {
                pushPath(raw);
            }
        }
    }

    // OSC 0/2: ESC ] 0;title BEL  (很多 shell 把 "user@host: /cwd" 放到 title)
    // 例："\x1b]0;root@host: /mnt\x07"
    {
        const re = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(data)) !== null) {
            const title = m[1] ?? "";
            // 尽量取最后一个 cwd token："/path" 或 "~" 或 "~/path"
            const mm = title.match(/((?:~(?:\/[^\s\x07\x1b]*)?)|(?:\/[^\s\x07\x1b]*))\s*$/);
            pushPath(mm?.[1]);
        }
    }

    // prompt 兜底：user@host:/path#  或 user@host:/path$  或 user@host:/path>
    {
        const re = /[A-Za-z0-9_.-]+@[^:\s]+:((?:~(?:\/[^\s#\$>]+)?)|(?:\/[^\s#\$>]+))\s*[#\$>]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(data)) !== null) {
            pushPath(m[1]);
        }
    }

    return paths;
}

/** 将终端输出转为字符串（用于 OSC 7 解析） */
export function terminalDataToString(data: unknown): string {
    if (typeof data === "string") return data;

    // tauri Channel 在不同平台/版本下可能传 Uint8Array / number[] / ArrayBuffer
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (Array.isArray(data)) return new TextDecoder().decode(new Uint8Array(data));

    // 兜底：避免 decode 抛 TypeError 中断终端渲染
    try {
        return String(data ?? "");
    } catch {
        return "";
    }
}
