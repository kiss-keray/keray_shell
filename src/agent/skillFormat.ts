/** 标准 Skill 的固定入口文件名。 */
export const SKILL_ENTRY_FILE = "SKILL.md";

const STANDARD_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Skill 名称同时作为目录名，只允许 64 个以内的小写字母、数字和连字符。 */
export function isStandardSkillName(name: string): boolean {
    return name.length <= 64 && STANDARD_SKILL_NAME.test(name);
}
