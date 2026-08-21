import { dirname, extname, isAbsolute, resolve, sep } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/**
 * 引入补充文档。三种写法等价，路径相对当前文件，且必须落在 agents 目录内：
 *   @include ./docs/foo.md
 *   @include: ./docs/foo.md
 *   <!-- @include: ./docs/foo.md -->
 */
const INCLUDE_LINE = /^(?:<!--\s*)?@include:?\s+(\S+?)(?:\s*-->)?\s*$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface MarkdownMeta {
    name?: string;
    description?: string;
}

export interface ResolvedMarkdown {
    path: string;
    meta: MarkdownMeta;
    /** 去掉 frontmatter、展开 @include 之后的正文 */
    body: string;
}

export function parseFrontmatter(raw: string): { meta: MarkdownMeta; body: string } {
    const match = raw.match(FRONTMATTER);
    if (!match) return { meta: {}, body: raw.trimStart() };
    const meta: MarkdownMeta = {};
    for (const line of match[1].split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = unquote(line.slice(idx + 1).trim());
        if (key === "name" || key === "description") meta[key] = value;
    }
    return { meta, body: raw.slice(match[0].length).trimStart() };
}

/**
 * 读取 md 并递归展开 @include。
 * stack 用来打断 A -> B -> A 的循环引用；路径解析与文件读取均使用 Tauri 异步 API。
 */
export async function resolveMarkdownFile(filePath: string, agentsDir: string, stack: string[] = []): Promise<ResolvedMarkdown> {
    const resolvedPath = await resolve(filePath);
    await assertInsideAgentsDir(resolvedPath, agentsDir);
    if (stack.includes(resolvedPath)) {
        throw new Error(`检测到循环引入: ${[...stack, resolvedPath].join(" -> ")}`);
    }
    if (!(await exists(resolvedPath))) {
        throw new Error(`找不到 markdown 文件: ${resolvedPath}`);
    }

    const { meta, body } = parseFrontmatter(await readTextFile(resolvedPath));
    const nextStack = [...stack, resolvedPath];
    const lines = body.split(/\r?\n/);
    const out: string[] = [];

    // include 有先后顺序，按文档行顺序 await，确保展开结果稳定且便于定位循环链。
    for (const line of lines) {
        const include = line.match(INCLUDE_LINE);
        if (!include) {
            out.push(line);
            continue;
        }
        const target = await resolveIncludePath(include[1], await dirname(resolvedPath), agentsDir);
        const nested = await resolveMarkdownFile(target, agentsDir, nextStack);
        out.push(nested.body.trimEnd());
    }

    return { path: resolvedPath, meta, body: out.join("\n").trim() };
}

/** 相对当前文件解析；无扩展名时补 .md。 */
export async function resolveIncludePath(spec: string, fromDir: string, agentsDir: string): Promise<string> {
    const trimmed = spec.replace(/^['"]|['"]$/g, "");
    const withExt = (await extname(trimmed)) ? trimmed : `${trimmed}.md`;
    const abs = (await isAbsolute(withExt)) ? await resolve(withExt) : await resolve(fromDir, withExt);
    await assertInsideAgentsDir(abs, agentsDir);
    return abs;
}

/**
 * resolve 会先消解 ..，随后用目录边界判断阻止越权读取。
 * 不能只用 startsWith(root)，否则 /agents-other 会被误认为位于 /agents 内。
 */
async function assertInsideAgentsDir(target: string, agentsDir: string): Promise<void> {
    const root = await resolve(agentsDir);
    const resolvedTarget = await resolve(target);
    const separator = sep();
    const rootWithBoundary = root.endsWith(separator) ? root : `${root}${separator}`;
    if (resolvedTarget !== root && !resolvedTarget.startsWith(rootWithBoundary)) {
        throw new Error(`markdown 引入必须位于 ${root} 内: ${target}`);
    }
}

function unquote(value: string): string {
    // Skill 保存器使用 JSON 双引号生成合法 YAML 标量；这里同步还原转义字符。
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value) as string;
        } catch {
            return value.slice(1, -1);
        }
    }
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
}
