<script setup lang="ts">
import { emitTo } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { storeToRefs } from "pinia";
import type { PrivateKeyModel, ServerGroupModel } from "@/stores/serverData";
import { EDIT_SERVER_SAVED_EVENT, type EditServerSavedPayload, type EditServerWindowPayload } from "@/utils/window";

type AuthMethod = "password" | "privateKey";

const appStore = useAppStore();
const serverDataStore = useServerDataStore();
const { windowInitData } = storeToRefs(appStore);
const { homeDir } = appStore;
const { privateKeyData, serverRootGroup } = storeToRefs(serverDataStore);
const { findGroupById, addPrivateKey, addServerData, deletePrivateKey, findServerDataById, privateKeyChange, serverDataChange, reloadServerData } = serverDataStore;
const currentWindow = getCurrentWindow();

const payload = ref<EditServerWindowPayload | null>(null);
const authMethod = ref<AuthMethod>("password");
const passwordVisible = ref(false);
const showPrivateKeyDialog = ref(false);
const privateKeyEditorId = ref<string>("");
const initForm = {
    name: "",
    ip: "",
    port: 22,
    user: "root",
    password: "",
    prkId: "",
    groupId: "root",
};
const form = reactive({ ...initForm });
const privateKeyForm = reactive({
    name: "",
    content: "",
    passphrase: "",
});

const modeTitle = computed(() => (payload.value?.mode === "edit" ? "编辑服务器" : "新建服务器"));
const submitText = computed(() => (payload.value?.mode === "edit" ? "保存修改" : "创建服务器"));
const isEditingServer = computed(() => payload.value?.mode === "edit");
const passwordPlaceholder = computed(() => (isEditingServer.value ? "留空则不修改密码" : "输入登录密码"));
const currentGroup = computed(() => findGroupById(form.groupId) ?? serverRootGroup.value);
const currentGroupName = computed(() => groupPath(currentGroup.value));
const selectedPrivateKey = computed(() => privateKeyData.value.find((item) => item.id === form.prkId));
const privateKeyEditorTitle = computed(() => (privateKeyEditorId.value ? "编辑私钥" : "新增私钥"));

watch(
    windowInitData,
    (data) => {
        if (data) {
            applyPayload(data as EditServerWindowPayload);
        }
    },
    { immediate: true },
);

watch(privateKeyEditorId, (id) => {
    const key = privateKeyData.value.find((item) => item.id === id);
    privateKeyForm.name = key?.name ?? "";
    privateKeyForm.content = key?.content ?? "";
    privateKeyForm.passphrase = key?.passphrase ?? "";
});

function groupPath(group: ServerGroupModel) {
    const names: string[] = [];
    let current: ServerGroupModel | undefined = group;
    while (current && current.id !== "root") {
        names.unshift(current.name);
        current = current.parent;
    }
    return names.length ? `/${names.join("/")}` : "/";
}

function resetPrivateKeyForm() {
    privateKeyEditorId.value = "";
    privateKeyForm.name = "";
    privateKeyForm.content = "";
    privateKeyForm.passphrase = "";
}

async function applyPayload(data: EditServerWindowPayload) {
    payload.value = data;
    await reloadServerData();

    if (data.mode === "edit" && data.serverId) {
        const server = findServerDataById(data.serverId);
        if (!server) {
            showToast("服务器不存在", "error");
            return;
        }
        form.name = server.name;
        form.ip = server.ip;
        form.port = server.port;
        form.user = server.user;
        form.password = "";
        passwordVisible.value = false;
        form.prkId = server.prkId ?? "";
        form.groupId = server.groupId || server.group?.id || data.groupId || "root";
        authMethod.value = server.prkId ? "privateKey" : "password";
        return;
    }
    Object.assign(form, initForm);
    authMethod.value = "password";
}

function buildServerInput() {
    const name = form.name.trim();
    const ip = form.ip.trim();
    const user = form.user.trim();
    const port = Number(form.port);
    if (!name || !ip || !user) {
        showToast("请填写服务器名称、地址和用户", "warning");
        return null;
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        showToast("端口范围应为 1-65535", "warning");
        return null;
    }
    if (authMethod.value === "privateKey" && !form.prkId) {
        showToast("请选择一个私钥", "warning");
        return null;
    }
    return {
        name,
        ip,
        port,
        user,
        password: authMethod.value === "password" ? form.password : undefined,
        prkId: authMethod.value === "privateKey" ? form.prkId : undefined,
    };
}

function groupHasSameServerName(group: ServerGroupModel, name: string, ignoreId?: string) {
    return group.servers.some((item) => item.id !== ignoreId && item.name === name);
}

async function submit(connect: boolean = false) {
    const data = buildServerInput();
    if (!data || !payload.value) return null;
    let editId = payload.value.serverId ?? "";
    if (payload.value.mode === "edit" && payload.value.serverId) {
        const server = findServerDataById(payload.value.serverId);
        if (!server || !server.group) {
            showToast("服务器不存在", "error");
            return null;
        }
        if (groupHasSameServerName(server.group, data.name, server.id)) {
            showToast("服务器名称已存在", "error");
            return null;
        }
        server.name = data.name;
        server.ip = data.ip;
        server.port = data.port;
        server.user = data.user;
        if (authMethod.value === "password") {
            server.prkId = undefined;
            server.password = data.password || server.password;
        } else {
            server.password = undefined;
            server.prkId = data.prkId;
        }
        await serverDataChange(server);
    } else {
        const group = currentGroup.value;
        if (groupHasSameServerName(group, data.name)) {
            showToast("服务器名称已存在", "error");
            return null;
        }
        const maxOrder = group.servers.reduce((max, item) => Math.max(max, item.order), 0);
        const serverData = await addServerData(
            {
                ...data,
                groupId: group.id,
                order: maxOrder + 1,
            },
            group,
        );
        editId = serverData?.id ?? "";
    }

    await emitTo<EditServerSavedPayload>(
        {
            kind: "Window",
            label: payload.value.from,
        },
        EDIT_SERVER_SAVED_EVENT,
        { sourceLabel: currentWindow.label, editId, connect },
    );
    await currentWindow.close();
}

function privateKeyNameExists(name: string, ignoreId?: string) {
    return privateKeyData.value.some((item) => item.id !== ignoreId && item.name === name);
}

function savePrivateKey() {
    const name = privateKeyForm.name.trim();
    const content = privateKeyForm.content.trim();
    if (!name || !content) {
        showToast("请填写私钥名称和内容", "warning");
        return;
    }
    if (privateKeyEditorId.value) {
        const key = privateKeyData.value.find((item) => item.id === privateKeyEditorId.value);
        if (!key) return;
        if (privateKeyNameExists(name, key.id)) {
            showToast("私钥名称已存在", "error");
            return;
        }
        key.name = name;
        key.content = content;
        key.passphrase = privateKeyForm.passphrase;
        privateKeyChange(key);
        showToast("私钥已更新", "success");
        return;
    }
    if (privateKeyNameExists(name)) {
        showToast("私钥名称已存在", "error");
        return;
    }
    addPrivateKey({ name, content, passphrase: privateKeyForm.passphrase });
    form.prkId = privateKeyData.value.find((item) => item.name === name)?.id ?? form.prkId;
    resetPrivateKeyForm();
    showToast("私钥已新增", "success");
}

async function removePrivateKey(key: PrivateKeyModel) {
    const ok = await showConfirm({
        title: "删除私钥",
        message: `确定删除私钥「${key.name}」吗？已选择它的服务器需要重新选择认证方式。`,
        danger: true,
    });
    if (!ok) return;
    deletePrivateKey(key);
    if (form.prkId === key.id) {
        form.prkId = "";
    }
    if (privateKeyEditorId.value === key.id) {
        resetPrivateKeyForm();
    }
}

function removeEditingPrivateKey() {
    const key = privateKeyData.value.find((item) => item.id === privateKeyEditorId.value);
    if (key) {
        removePrivateKey(key);
    }
}

function privateKeyNameFromPath(filePath: string) {
    const base = filePath.split(/[/\\]/).pop() ?? "";
    return base.replace(/\.(pem|key|ppk)$/i, "") || base;
}

function looksLikePrivateKey(content: string) {
    return /-----BEGIN\s+(?:OPENSSH\s+|RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+)?PRIVATE KEY-----/.test(content);
}

async function pickPrivateKeyFile() {
    const defaultPath = await join(await homeDir, ".ssh");

    const selected = await open({
        title: "选择私钥文件",
        multiple: false,
        directory: false,
        defaultPath,
    });
    if (!selected || Array.isArray(selected)) return;

    try {
        const content = (await readTextFile(selected)).trim();
        if (!content) {
            showToast("私钥文件内容为空", "warning");
            return;
        }
        if (!looksLikePrivateKey(content)) {
            showToast("文件内容不像 SSH 私钥，请确认后保存", "warning");
        }
        privateKeyForm.content = content;
        if (!privateKeyForm.name.trim()) {
            privateKeyForm.name = privateKeyNameFromPath(selected);
        }
        showToast("已读取私钥文件", "success");
    } catch (err) {
        console.error("read private key file error:", err);
        showToast("读取私钥文件失败", "error");
    }
}
</script>

<template>
    <main class="edit-server-page">
        <header class="edit-server-header">
            <div class="edit-server-title-block">
                <p class="edit-server-kicker">Edit Server</p>
                <h1 class="edit-server-title">{{ modeTitle }}</h1>
            </div>
            <GlobalButton :bts="['setting', 'theme', 'themeMode']" />
        </header>

        <form class="edit-server-card edit-server-form" @submit.prevent="submit(false)">
            <div class="edit-server-section-title">服务器信息</div>
            <p class="edit-server-group-text">当前分组：{{ currentGroupName }}</p>
            <label class="edit-server-field">
                <span>名称</span>
                <SystemInput v-model="form.name" type="text" placeholder="例如：生产服务器" />
            </label>
            <div class="edit-server-grid">
                <label class="edit-server-field">
                    <span>地址</span>
                    <SystemInput v-model="form.ip" type="text" placeholder="IP 或域名" />
                </label>
                <label class="edit-server-field">
                    <span>端口</span>
                    <input v-model.number="form.port" type="number" min="1" max="65535" />
                </label>
            </div>
            <label class="edit-server-field">
                <span>用户</span>
                <SystemInput v-model="form.user" type="text" placeholder="root" />
            </label>

            <div class="edit-server-section-title">连接方式</div>
            <div class="edit-server-auth-tabs">
                <button type="button" class="edit-server-auth-tab" :class="{ active: authMethod === 'password' }" @click="authMethod = 'password'">账户密码</button>
                <button type="button" class="edit-server-auth-tab" :class="{ active: authMethod === 'privateKey' }" @click="authMethod = 'privateKey'">账户私钥</button>
            </div>
            <label v-if="authMethod === 'password'" class="edit-server-field">
                <span>{{ isEditingServer ? "新密码" : "密码" }}</span>
                <div class="edit-server-password-wrap">
                    <input v-model="form.password" :type="passwordVisible ? 'text' : 'password'" :placeholder="passwordPlaceholder" autocomplete="new-password" />
                    <button class="edit-server-password-toggle" type="button" :aria-label="passwordVisible ? '隐藏密码明文' : '显示密码明文'" @click="passwordVisible = !passwordVisible">
                        <Icon :icon="passwordVisible ? 'lucide:eye-off' : 'lucide:eye'" />
                    </button>
                </div>
                <small v-if="isEditingServer">已保存密码不会显示，留空将继续使用原密码。</small>
            </label>
            <label v-else class="edit-server-field">
                <span>私钥</span>
                <select v-model="form.prkId">
                    <option value="">请选择私钥</option>
                    <option v-for="key in privateKeyData" :key="key.id" :value="key.id">{{ key.name }}</option>
                </select>
                <small v-if="selectedPrivateKey">已选择：{{ selectedPrivateKey.name }}</small>
                <small v-else>点击底部“私钥管理”新增或维护私钥。</small>
            </label>

            <div class="edit-server-actions">
                <button class="edit-server-ghost-btn" type="button" @click="showPrivateKeyDialog = true">私钥管理</button>
                <button class="edit-server-ghost-btn" type="button" @click="submit(true)">保存并连接</button>
                <button class="edit-server-primary-btn" type="submit">{{ submitText }}</button>
            </div>
        </form>

        <div v-if="showPrivateKeyDialog" class="edit-server-key-mask" @click="showPrivateKeyDialog = false">
            <section class="edit-server-key-dialog" role="dialog" aria-modal="true" @click.stop>
                <header class="edit-server-key-dialog-head">
                    <div class="edit-server-key-dialog-title-block">
                        <p class="edit-server-kicker">Private Keys</p>
                        <h2 class="edit-server-dialog-title">私钥管理</h2>
                        <p class="edit-server-dialog-subtitle">统一维护 SSH 登录私钥，保存后可在服务器认证方式中选择。</p>
                    </div>
                    <button class="edit-server-icon-btn" type="button" aria-label="关闭私钥管理" @click="showPrivateKeyDialog = false">
                        <Icon icon="lucide:x" />
                    </button>
                </header>

                <div class="edit-server-key-dialog-body">
                    <aside class="edit-server-key-sidebar">
                        <div class="edit-server-key-sidebar-head">
                            <div>
                                <span class="edit-server-key-sidebar-title">已保存私钥</span>
                                <small>{{ privateKeyData.length }} 个</small>
                            </div>
                            <button class="edit-server-link-btn" type="button" @click="resetPrivateKeyForm">新增</button>
                        </div>
                        <div class="edit-server-key-list">
                            <button
                                v-for="key in privateKeyData"
                                :key="key.id"
                                type="button"
                                class="edit-server-key-item"
                                :class="{ active: privateKeyEditorId === key.id }"
                                @click="privateKeyEditorId = key.id"
                            >
                                <span class="edit-server-key-item-name">{{ key.name }}</span>
                                <span class="edit-server-key-item-action">
                                    <Icon icon="lucide:pencil" />
                                </span>
                            </button>
                            <div v-if="!privateKeyData.length" class="edit-server-key-empty">
                                <Icon icon="lucide:key-round" />
                                <p class="edit-server-empty-text">还没有保存私钥</p>
                                <small>在右侧填写名称和私钥内容后保存，或从文件导入。</small>
                            </div>
                        </div>
                    </aside>

                    <section class="edit-server-key-editor">
                        <div class="edit-server-key-editor-head">
                            <div>
                                <span>{{ privateKeyEditorTitle }}</span>
                                <small>{{ privateKeyEditorId ? "正在修改已保存私钥" : "创建一个新的 SSH 私钥" }}</small>
                            </div>
                        </div>
                        <div class="edit-server-key-meta-grid">
                            <label class="edit-server-field">
                                <span>私钥名称</span>
                                <input v-model="privateKeyForm.name" type="text" placeholder="例如：公司跳板机" />
                            </label>
                            <label class="edit-server-field">
                                <span>私钥密码</span>
                                <input v-model="privateKeyForm.passphrase" type="password" placeholder="可选" />
                            </label>
                        </div>
                        <label class="edit-server-field edit-server-key-content-field">
                            <div class="edit-server-key-content-head">
                                <span>私钥内容</span>
                                <button class="edit-server-link-btn" type="button" @click="pickPrivateKeyFile">从文件选择</button>
                            </div>
                            <textarea v-model="privateKeyForm.content" rows="10" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
                        </label>
                        <div class="edit-server-key-actions">
                            <button v-if="privateKeyEditorId" class="edit-server-danger-btn" type="button" @click="removeEditingPrivateKey">删除</button>
                            <button class="edit-server-primary-btn" type="button" @click="savePrivateKey">保存私钥</button>
                        </div>
                    </section>
                </div>
            </section>
        </div>
    </main>
</template>

<style scoped lang="scss">
.edit-server-page {
    width: 100%;
    min-height: 100vh;
    padding: 38px 34px 28px;
    overflow: auto;

    .edit-server-header,
    .edit-server-grid,
    .edit-server-actions,
    .edit-server-auth-tabs,
    .edit-server-key-dialog-head,
    .edit-server-key-dialog-body,
    .edit-server-key-sidebar-head,
    .edit-server-key-editor-head,
    .edit-server-key-content-head,
    .edit-server-key-actions {
        display: flex;
    }

    .edit-server-header {
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 16px;
    }

    .edit-server-title-block {
        min-width: 0;
    }

    .edit-server-kicker,
    .edit-server-title,
    .edit-server-dialog-title,
    .edit-server-dialog-subtitle,
    .edit-server-empty-text {
        margin: 0;
    }

    .edit-server-kicker {
        font-size: var(--font-size-xs);
        letter-spacing: 0.16em;
        text-transform: uppercase;
    }

    .edit-server-title {
        margin-top: 4px;
        font-size: var(--font-size-icon);
        line-height: 1.15;
        font-weight: 700;
    }

    .edit-server-dialog-title {
        margin-top: 4px;
        font-size: var(--font-size-3xl);
        line-height: 1.2;
        font-weight: 700;
    }

    .edit-server-dialog-subtitle {
        margin-top: 6px;
        line-height: 1.45;
    }

    .edit-server-card {
        width: min(620px, 100%);
        border-radius: 14px;
        padding: 16px;
    }

    .edit-server-form {
        margin: 0 auto;
    }

    .edit-server-section-title {
        margin: 2px 0 12px;
        font-size: var(--font-size-md);
        font-weight: 700;
    }

    .edit-server-group-text {
        margin: -4px 0 12px;
    }

    .edit-server-grid {
        gap: 10px;

        .edit-server-field {
            flex: 1;
        }
    }

    .edit-server-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;

        input,
        select,
        textarea {
            width: 100%;
            border-radius: 9px;
            padding: 8px 10px;
            outline: none;
            font: inherit;
        }

        textarea {
            min-height: 128px;
            resize: vertical;
            line-height: 1.45;
        }

        small {
            font-size: var(--font-size-xs);
            line-height: 1.35;
        }
    }

    .edit-server-auth-tabs {
        gap: 8px;
        margin-bottom: 12px;
    }

    .edit-server-auth-tab,
    .edit-server-ghost-btn,
    .edit-server-primary-btn,
    .edit-server-danger-btn,
    .edit-server-link-btn,
    .edit-server-icon-btn,
    .edit-server-key-item {
        border-radius: 9px;
        font: inherit;
        cursor: pointer;
    }

    .edit-server-auth-tab,
    .edit-server-ghost-btn,
    .edit-server-primary-btn,
    .edit-server-danger-btn {
        min-height: 32px;
        padding: 0 12px;
    }

    .edit-server-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        flex: 0 0 auto;

        svg {
            width: 16px;
            height: 16px;
        }
    }

    .edit-server-password-wrap {
        position: relative;
        display: flex;
        align-items: center;

        input {
            padding-right: 40px;
        }
    }

    .edit-server-password-toggle {
        position: absolute;
        right: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        font: inherit;
        cursor: pointer;

        svg {
            width: 15px;
            height: 15px;
        }
    }

    .edit-server-actions,
    .edit-server-key-actions {
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
    }

    .edit-server-key-mask {
        position: fixed;
        inset: 0;
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 22px;
    }

    .edit-server-key-dialog {
        width: min(920px, 100%);
        max-height: min(760px, calc(100vh - 44px));
        border-radius: 18px;
        padding: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .edit-server-key-dialog-head {
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 20px 16px;
        flex: 0 0 auto;
    }

    .edit-server-key-dialog-title-block {
        min-width: 0;
    }

    .edit-server-key-dialog-body {
        min-height: 0;
        flex: 1;
        padding: 0 20px 20px;
        overflow: hidden;
    }

    .edit-server-key-sidebar {
        display: flex;
        flex: 0 0 260px;
        flex-direction: column;
        min-height: 0;
        border-radius: 14px;
        padding: 12px;
    }

    .edit-server-key-sidebar-head {
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;

        div {
            min-width: 0;
        }

        small {
            display: block;
            margin-top: 2px;
            font-size: var(--font-size-xs);
        }
    }

    .edit-server-key-sidebar-title {
        display: block;
        font-size: var(--font-size-md);
        font-weight: 700;
    }

    .edit-server-key-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        overflow: auto;
    }

    .edit-server-key-item {
        min-height: 44px;
        padding: 0 10px 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;

        .edit-server-key-item-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .edit-server-key-item-action {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border-radius: 7px;
            flex: 0 0 auto;
        }

        svg {
            width: 14px;
            height: 14px;
            flex: 0 0 auto;
        }
    }

    .edit-server-key-empty {
        display: grid;
        place-items: center;
        min-height: 190px;
        padding: 18px;
        border-radius: 12px;
        text-align: center;

        svg {
            width: 28px;
            height: 28px;
            margin-bottom: 10px;
        }

        small {
            margin-top: 6px;
            font-size: var(--font-size-xs);
            line-height: 1.45;
        }
    }

    .edit-server-key-editor {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        margin-left: 14px;
        border-radius: 14px;
        padding: 14px;
    }

    .edit-server-key-editor-head {
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        font-size: var(--font-size-md);
        font-weight: 700;

        div {
            min-width: 0;
        }

        small {
            display: block;
            margin-top: 3px;
            font-size: var(--font-size-xs);
            font-weight: 400;
        }
    }

    .edit-server-link-btn {
        padding: 0;
    }

    .edit-server-key-new-btn {
        flex: 0 0 auto;
    }

    .edit-server-key-meta-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 12px;
    }

    .edit-server-key-content-head {
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .edit-server-key-content-field {
        flex: 1;
        min-height: 0;

        textarea {
            flex: 1;
            min-height: 220px;
        }
    }

    .edit-server-key-actions {
        padding-top: 12px;
        margin-top: auto;
    }
}
</style>
