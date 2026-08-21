<script setup lang="ts">
import { TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { deleteUserSkill, listUserSkills, saveUserSkill, USER_SKILLS_DIR, type UserSkill } from "@/agent/skillStorage";

defineOptions({ name: "SkillsWin" });

type EditorMode = "empty" | "create" | "edit";
type SkillDraft = Pick<UserSkill, "name" | "description" | "body">;

const currentWindow = getCurrentWindow();
const isMacOS = useAppStore().osType === "macos";
const skills = ref<UserSkill[]>([]);
const mode = ref<EditorMode>("empty");
const selectedDirectoryName = ref<string | null>(null);
const searchText = ref("");
const loading = ref(true);
const saving = ref(false);
const loadError = ref("");
const persistedDraft = ref<SkillDraft>(emptyDraft());
const draft = reactive<SkillDraft>(emptyDraft());
let unlistenClose: UnlistenFn | null = null;
let closing = false;

const filteredSkills = computed(() => {
    const keyword = searchText.value.trim().toLocaleLowerCase();
    if (!keyword) return skills.value;
    return skills.value.filter((skill) =>
        [skill.name, skill.description, skill.directoryName].some((value) => value.toLocaleLowerCase().includes(keyword)),
    );
});

const isDirty = computed(() => {
    if (mode.value === "empty") return false;
    return (
        draft.name !== persistedDraft.value.name ||
        draft.description !== persistedDraft.value.description ||
        draft.body !== persistedDraft.value.body
    );
});

const editorTitle = computed(() => {
    if (mode.value === "create") return "新建 Skill";
    if (mode.value === "edit") return draft.name || selectedDirectoryName.value || "编辑 Skill";
    return "选择一个 Skill";
});

onMounted(async () => {
    document.body.classList.add("skills-window");
    await reloadSkills();
    window.addEventListener("keydown", onShortcut);
    // App.vue 对本窗口放弃统一销毁，由这里在关闭前检查未保存内容。
    unlistenClose = await currentWindow.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, () => {
        void closeWindow();
    });
});

onBeforeUnmount(() => {
    document.body.classList.remove("skills-window");
    window.removeEventListener("keydown", onShortcut);
    unlistenClose?.();
});

function emptyDraft(): SkillDraft {
    return { name: "", description: "", body: "" };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function replaceDraft(next: SkillDraft) {
    Object.assign(draft, next);
    persistedDraft.value = { ...next };
}

function applySkill(skill: UserSkill) {
    selectedDirectoryName.value = skill.directoryName;
    mode.value = "edit";
    replaceDraft(skill);
}

async function reloadSkills(preferredDirectoryName?: string) {
    loading.value = true;
    loadError.value = "";
    try {
        skills.value = await listUserSkills();
        const nextDirectoryName = preferredDirectoryName ?? selectedDirectoryName.value;
        const next = skills.value.find((skill) => skill.directoryName === nextDirectoryName) ?? skills.value[0];
        if (next) applySkill(next);
        else beginNewSkill();
    } catch (error) {
        console.error("load user skills error:", error);
        loadError.value = `读取用户 Skills 失败：${getErrorMessage(error)}`;
        mode.value = "empty";
    } finally {
        loading.value = false;
    }
}

async function confirmDiscard(): Promise<boolean> {
    if (!isDirty.value) return true;
    return await showConfirm({
        title: "放弃未保存的修改？",
        message: "当前 Skill 还有未保存的内容，继续操作将丢失这些修改。",
        confirmText: "放弃修改",
        danger: true,
    });
}

async function selectSkill(skill: UserSkill) {
    if (skill.directoryName === selectedDirectoryName.value && mode.value === "edit") return;
    if (!(await confirmDiscard())) return;
    applySkill(skill);
}

async function startCreate() {
    if (!(await confirmDiscard())) return;
    beginNewSkill();
}

function beginNewSkill() {
    selectedDirectoryName.value = null;
    mode.value = "create";
    replaceDraft(emptyDraft());
}

async function refresh() {
    if (!(await confirmDiscard())) return;
    await reloadSkills();
}

async function save() {
    if (mode.value === "empty" || saving.value) return;
    saving.value = true;
    try {
        const saved = await saveUserSkill({
            originalDirectoryName: mode.value === "edit" ? (selectedDirectoryName.value ?? undefined) : undefined,
            name: draft.name,
            description: draft.description,
            body: draft.body,
        });
        await reloadSkills(saved.directoryName);
        showToast("Skill 已保存，Agent 将自动热更新", "success");
    } catch (error) {
        console.error("save user skill error:", error);
        showToast(getErrorMessage(error), "error");
    } finally {
        saving.value = false;
    }
}

async function removeSelected() {
    if (mode.value !== "edit" || !selectedDirectoryName.value) return;
    const confirmed = await showConfirm({
        title: "删除 Skill",
        message: `确定删除「${draft.name || selectedDirectoryName.value}」吗？该目录中的全部资源也会被删除，此操作不可恢复。`,
        confirmText: "删除",
        danger: true,
    });
    if (!confirmed) return;
    try {
        await deleteUserSkill(selectedDirectoryName.value);
        selectedDirectoryName.value = null;
        await reloadSkills();
        showToast("Skill 已删除", "success");
    } catch (error) {
        console.error("delete user skill error:", error);
        showToast(`删除失败：${getErrorMessage(error)}`, "error");
    }
}

function onShortcut(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        void save();
    }
}

async function closeWindow() {
    if (closing) return;
    if (!(await confirmDiscard())) {
        await currentWindow.setFocus();
        return;
    }
    closing = true;
    await currentWindow.destroy();
}
</script>

<template>
    <main class="skills-manager" :class="{ 'is-macos': isMacOS }">
        <header class="skills-manager-header" data-tauri-drag-region="">
            <div class="skills-manager-heading" data-tauri-drag-region="">
                <Icon icon="mdi:lightning-bolt-outline" />
                <span data-tauri-drag-region="">Skills 管理</span>
                <small>{{ skills.length }} 个用户 Skill</small>
            </div>
            <div class="skills-manager-actions">
                <button type="button" class="skills-btn secondary" title="重新读取磁盘文件" @click="refresh">
                    <Icon icon="mdi:refresh" />
                    刷新
                </button>
                <button type="button" class="skills-btn" @click="startCreate">
                    <Icon icon="mdi:plus" />
                    新建
                </button>
                <button v-if="!isMacOS" type="button" class="skills-window-close" title="关闭" aria-label="关闭" @click="closeWindow">
                    <Icon icon="mdi:close" />
                </button>
            </div>
        </header>

        <section class="skills-manager-body">
            <aside class="skills-sidebar">
                <label class="skills-search">
                    <Icon icon="mdi:magnify" />
                    <SystemInput v-model="searchText" type="search" placeholder="搜索名称、描述或目录名" aria-label="搜索 Skills" />
                </label>
                <div class="skills-list" aria-label="用户 Skills 列表">
                    <p v-if="loading" class="skills-state">正在读取 Skills...</p>
                    <div v-else-if="loadError" class="skills-state error" role="alert">
                        <span>{{ loadError }}</span>
                        <button type="button" class="skills-link-btn" @click="reloadSkills()">重试</button>
                    </div>
                    <button
                        v-for="skill in filteredSkills"
                        v-else
                        :key="skill.directoryName"
                        type="button"
                        class="skills-list-item"
                        :class="{ active: mode === 'edit' && selectedDirectoryName === skill.directoryName }"
                        @click="selectSkill(skill)"
                    >
                        <span class="skills-list-name">{{ skill.name }}</span>
                        <span class="skills-list-description">{{ skill.description || "未填写描述" }}</span>
                        <code>{{ skill.directoryName }}/SKILL.md</code>
                    </button>
                    <p v-if="!loading && !loadError && !filteredSkills.length" class="skills-state">
                        {{ searchText.trim() ? "没有匹配的 Skill" : "还没有用户 Skill，点击“新建”开始创建" }}
                    </p>
                </div>
                <p class="skills-directory" :title="USER_SKILLS_DIR">用户目录：{{ USER_SKILLS_DIR }}</p>
            </aside>

            <section class="skills-editor">
                <div v-if="mode === 'empty'" class="skills-editor-empty">
                    <Icon icon="mdi:lightning-bolt-outline" />
                    <p>选择或新建一个 Skill</p>
                </div>
                <template v-else>
                    <header class="skills-editor-header">
                        <div>
                            <h1>{{ editorTitle }}</h1>
                            <p>{{ mode === "create" ? "创建后会保存为 name/SKILL.md" : `${selectedDirectoryName}/SKILL.md` }}</p>
                        </div>
                        <span v-if="isDirty" class="skills-unsaved">未保存</span>
                    </header>
                    <div class="skills-form">
                        <label class="skills-field">
                            <span>名称（小写英文、数字、连字符） <em>必填</em></span>
                            <SystemInput v-model="draft.name" type="text" maxlength="64" placeholder="例如：server-health-check" />
                        </label>
                        <label class="skills-field">
                            <span>描述 <em>必填</em></span>
                            <SystemInput
                                v-model="draft.description"
                                type="text"
                                maxlength="300"
                                placeholder="简要说明何时应该使用这个 Skill"
                            />
                        </label>
                        <label class="skills-field skills-content-field">
                            <span>Skill 内容 <em>必填</em></span>
                            <textarea
                                v-model="draft.body"
                                autocomplete="off"
                                autocapitalize="off"
                                autocorrect="off"
                                spellcheck="false"
                                placeholder="# 执行步骤&#10;&#10;在这里使用 Markdown 编写完整指令……"
                            />
                        </label>
                    </div>
                    <footer class="skills-editor-footer">
                        <button v-if="mode === 'edit'" type="button" class="skills-btn danger" @click="removeSelected">
                            <Icon icon="mdi:trash-can-outline" />
                            删除
                        </button>
                        <span class="skills-save-hint">{{ isDirty ? "按 Ctrl/⌘ + S 保存" : "所有修改已保存" }}</span>
                        <button type="button" class="skills-btn primary" :disabled="saving || !isDirty" @click="save">
                            <Icon :icon="saving ? 'mdi:loading' : 'mdi:content-save-outline'" :class="{ 'app-loading-spin': saving }" />
                            {{ saving ? "保存中..." : "保存" }}
                        </button>
                    </footer>
                </template>
            </section>
        </section>
    </main>
</template>

<style scoped lang="scss">
.skills-manager {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    box-sizing: border-box;
}

.skills-manager-header {
    height: 52px;
    flex: 0 0 52px;
    padding: 0 14px 0 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}

/* 组件状态类只调整本窗口标题栏，不能把 padding 误加到全局 html.macos。 */
.skills-manager.is-macos .skills-manager-header {
    padding-left: 78px;
}

.skills-manager-heading,
.skills-manager-actions,
.skills-editor-header,
.skills-editor-footer {
    display: flex;
    align-items: center;
}

.skills-manager-heading {
    min-width: 0;
    gap: 8px;
    font-size: var(--font-size-xl);
    font-weight: 650;

    svg {
        width: 20px;
        height: 20px;
    }

    small {
        margin-left: 4px;
        font-size: var(--font-size-xs);
        font-weight: 400;
    }
}

.skills-manager-actions {
    position: relative;
    z-index: 2;
    gap: 8px;
}

.skills-manager-body {
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
}

.skills-sidebar {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 12px 10px 10px;
}

.skills-search {
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    flex: 0 0 auto;
    border-radius: 8px;

    svg {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
    }

    input {
        min-width: 0;
        flex: 1;
        border: 0;
        outline: 0;
        background: transparent;
        font: inherit;
    }
}

.skills-list {
    flex: 1;
    min-height: 0;
    margin-top: 10px;
    overflow: auto;
}

.skills-list-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    margin-bottom: 6px;
    padding: 10px;
    border-radius: 9px;
    text-align: left;
    cursor: pointer;

    code {
        overflow: hidden;
        font-size: var(--font-size-xs);
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}

.skills-list-name {
    overflow: hidden;
    font-size: var(--font-size-md);
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.skills-list-description {
    display: -webkit-box;
    overflow: hidden;
    font-size: var(--font-size-xs);
    line-height: 1.4;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
}

.skills-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin: 24px 8px;
    font-size: var(--font-size-sm);
    line-height: 1.5;
    text-align: center;
}

.skills-directory {
    flex: 0 0 auto;
    overflow: hidden;
    margin: 8px 2px 0;
    font-size: var(--font-size-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.skills-editor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}

.skills-editor-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;

    svg {
        width: 36px;
        height: 36px;
    }
}

.skills-editor-header {
    min-height: 66px;
    padding: 10px 18px;
    justify-content: space-between;
    gap: 12px;

    h1,
    p {
        overflow: hidden;
        margin: 0;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    h1 {
        font-size: var(--font-size-xl);
    }

    p {
        margin-top: 3px;
        font-size: var(--font-size-xs);
    }
}

.skills-unsaved {
    flex: 0 0 auto;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: var(--font-size-xs);
}

.skills-form {
    flex: 1;
    min-height: 0;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
}

.skills-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: var(--font-size-sm);
    font-weight: 600;

    em {
        font-size: var(--font-size-xs);
        font-style: normal;
        font-weight: 400;
    }

    input,
    textarea {
        width: 100%;
        padding: 9px 10px;
        border-radius: 8px;
        outline: 0;
        font: inherit;
        font-weight: 400;
        box-sizing: border-box;
    }

    textarea {
        flex: 1;
        min-height: 220px;
        resize: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        line-height: 1.55;
        tab-size: 4;
    }
}

.skills-content-field {
    flex: 1;
    min-height: 260px;
}

.skills-editor-footer {
    min-height: 56px;
    padding: 8px 18px;
    gap: 10px;
}

.skills-save-hint {
    flex: 1;
    font-size: var(--font-size-xs);
    text-align: right;
}

.skills-btn,
.skills-window-close,
.skills-link-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    cursor: pointer;

    &:disabled {
        cursor: not-allowed;
    }
}

.skills-btn {
    min-height: 32px;
    padding: 0 11px;
    border-radius: 8px;
    font-size: var(--font-size-sm);

    svg {
        width: 15px;
        height: 15px;
    }
}

.skills-window-close {
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 8px;
}

.skills-link-btn {
    padding: 0;
    font: inherit;
}

@media (max-width: 720px) {
    .skills-manager-body {
        grid-template-columns: 220px minmax(0, 1fr);
    }

    .skills-manager-heading small,
    .skills-btn.secondary {
        display: none;
    }
}
</style>
