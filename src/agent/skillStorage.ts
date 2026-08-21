import { extname, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { CUSTOM_AGENTS_DIR } from "./paths";
import { parseFrontmatter } from "./prompt/include";
import { isStandardSkillName, SKILL_ENTRY_FILE } from "./skillFormat";

/** 用户 Skills 固定存放在 custom 下，应用升级只会替换 builtin，不会覆盖这里。 */
export const USER_SKILLS_DIR = await join(CUSTOM_AGENTS_DIR, "skills");

export interface UserSkill {
    directoryName: string;
    path: string;
    name: string;
    description: string;
    body: string;
}

export interface SaveUserSkillInput {
    originalDirectoryName?: string;
    name: string;
    description: string;
    body: string;
}

/** 读取目录式用户 Skills；frontmatter 损坏时仍以目录名展示，方便用户从界面修复。 */
export async function listUserSkills(): Promise<UserSkill[]> {
    await ensureUserSkillsDir();
    const skills: UserSkill[] = [];
    for (const entry of await readDir(USER_SKILLS_DIR)) {
        if (!entry.isDirectory || entry.isSymlink || !isStandardSkillName(entry.name)) continue;
        const path = await join(USER_SKILLS_DIR, entry.name, SKILL_ENTRY_FILE);
        if (!(await exists(path))) continue;
        const raw = await readTextFile(path);
        const { meta, body } = parseFrontmatter(raw);
        skills.push({
            directoryName: entry.name,
            path,
            name: meta.name?.trim() || entry.name,
            description: meta.description?.trim() || "",
            body,
        });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/**
 * 标准 Skill 要求目录名与 frontmatter name 一致，因此改名时会连同整个目录一起重命名，
 * 目录中的 references/scripts/assets 等资源也会完整保留。
 */
export async function saveUserSkill(input: SaveUserSkillInput): Promise<UserSkill> {
    const name = singleLine(input.name);
    const description = singleLine(input.description);
    const body = input.body.trim();
    if (!name) throw new Error("Skill 名称不能为空");
    assertStandardSkillName(name);
    if (!description) throw new Error("Skill 描述不能为空");
    if (!body) throw new Error("Skill 内容不能为空");

    await ensureUserSkillsDir();
    const currentSkills = await listUserSkills();
    const duplicate = currentSkills.find(
        (skill) => skill.directoryName !== input.originalDirectoryName && skill.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (duplicate) throw new Error(`已存在同名 Skill：${duplicate.name}`);

    const originalDirectoryName = input.originalDirectoryName ? assertSkillDirectoryName(input.originalDirectoryName) : undefined;
    const directoryName = name;
    const directoryPath = await join(USER_SKILLS_DIR, directoryName);
    let renamedFrom: string | undefined;
    let createdDirectory = false;

    if (originalDirectoryName) {
        const originalPath = await join(USER_SKILLS_DIR, originalDirectoryName);
        if (!(await exists(originalPath))) throw new Error(`Skill 目录 ${originalDirectoryName} 不存在`);
        if (originalDirectoryName !== directoryName) {
            if (await exists(directoryPath)) throw new Error(`Skill 目录 ${directoryName} 已存在，请换一个名称`);
            await rename(originalPath, directoryPath);
            renamedFrom = originalPath;
        }
    } else {
        if (await exists(directoryPath)) throw new Error(`Skill 目录 ${directoryName} 已存在，请换一个名称`);
        await mkdir(directoryPath, { recursive: false });
        createdDirectory = true;
    }

    const path = await join(directoryPath, SKILL_ENTRY_FILE);
    try {
        await writeTextFile(path, serializeSkill(name, description, body), {
            create: true,
            createNew: !originalDirectoryName,
        });
    } catch (error) {
        // 写入口文件失败时尽量恢复原目录，避免一次保存把现有 Skill 留在半改名状态。
        if (renamedFrom) await rename(directoryPath, renamedFrom).catch(() => undefined);
        if (createdDirectory) await remove(directoryPath, { recursive: true }).catch(() => undefined);
        throw error;
    }
    return { directoryName, path, name, description, body };
}

/** 删除前由界面进行二次确认；会删除该 Skill 目录及其全部标准资源。 */
export async function deleteUserSkill(directoryName: string): Promise<void> {
    const safeDirectoryName = assertSkillDirectoryName(directoryName);
    await remove(await join(USER_SKILLS_DIR, safeDirectoryName), { recursive: true });
}

async function ensureUserSkillsDir(): Promise<void> {
    if (!(await exists(USER_SKILLS_DIR))) {
        await mkdir(USER_SKILLS_DIR, { recursive: true });
    }
}

/** frontmatter 元数据只允许单行，换行统一折叠为空格。 */
function singleLine(value: string): string {
    return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** 新建和编辑都严格遵守标准 Skill 的小写字母、数字和连字符命名规则。 */
function assertStandardSkillName(name: string): void {
    if (!isStandardSkillName(name)) {
        throw new Error("Skill 名称只能包含小写英文字母、数字和连字符，且不能超过 64 个字符");
    }
}

function assertSkillDirectoryName(directoryName: string): string {
    if (!isStandardSkillName(directoryName)) {
        throw new Error("无效的 Skill 目录名");
    }
    return directoryName;
}

/** JSON 字符串也是合法 YAML 标量，可安全保存冒号、引号等 description 内容。 */
function serializeSkill(name: string, description: string, body: string): string {
    return [`---`, `name: ${name}`, `description: ${JSON.stringify(description)}`, `---`, "", body, ""].join("\n");
}
