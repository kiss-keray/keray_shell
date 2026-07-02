"use client";

import { emitTo } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useState } from "react";
import GlobalButton from "@/components/GlobalButton";
import Icon from "@/components/Icon";
import SystemInput from "@/components/SystemInput";
import { useAppStore } from "@/stores/app";
import { useServerDataStore, type PrivateKeyModel, type ServerGroupModel } from "@/stores/serverData";
import { showConfirm, showToast } from "@/utils/ui";
import { EDIT_SERVER_SAVED_EVENT, type EditServerSavedPayload, type EditServerWindowPayload } from "@/utils/window";
import "./index.scss";

type AuthMethod = "password" | "privateKey";

const initForm = {
    name: "",
    ip: "",
    port: 22,
    user: "root",
    password: "",
    prkId: "",
    groupId: "root",
};

function toVueModelNumber(value: string): number {
    // Vue v-model.number 会在空字符串等无法解析的值上保留原值，提交时再由校验逻辑拦截。
    const parsed = parseFloat(value);
    return (Number.isNaN(parsed) ? value : parsed) as unknown as number;
}

export default function EditServerWin() {
    const windowInitData = useAppStore((state) => state.windowInitData);
    const privateKeyData = useServerDataStore((state) => state.privateKeyData);
    const serverRootGroup = useServerDataStore((state) => state.serverRootGroup);
    const [payload, setPayload] = useState<EditServerWindowPayload | null>(null);
    const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
    const [passwordVisible, setPasswordVisible] = useState(false);
    const [showPrivateKeyDialog, setShowPrivateKeyDialog] = useState(false);
    const [privateKeyEditorId, setPrivateKeyEditorId] = useState("");
    const [form, setForm] = useState({ ...initForm });
    const [privateKeyForm, setPrivateKeyForm] = useState({ name: "", content: "", passphrase: "" });

    const modeTitle = payload?.mode === "edit" ? "编辑服务器" : "新建服务器";
    const submitText = payload?.mode === "edit" ? "保存修改" : "创建服务器";
    const isEditingServer = payload?.mode === "edit";
    const passwordPlaceholder = isEditingServer ? "留空则不修改密码" : "输入登录密码";
    const currentGroup = useMemo(() => useServerDataStore.getState().findGroupById(form.groupId) ?? serverRootGroup, [form.groupId, serverRootGroup]);
    const currentGroupName = useMemo(() => groupPath(currentGroup), [currentGroup]);
    const selectedPrivateKey = useMemo(() => privateKeyData.find((item) => item.id === form.prkId), [form.prkId, privateKeyData]);
    const privateKeyEditorTitle = privateKeyEditorId ? "编辑私钥" : "新增私钥";

    useEffect(() => {
        if (windowInitData) void applyPayload(windowInitData as EditServerWindowPayload);
    }, [windowInitData]);

    useEffect(() => {
        const key = privateKeyData.find((item) => item.id === privateKeyEditorId);
        setPrivateKeyForm({
            name: key?.name ?? "",
            content: key?.content ?? "",
            passphrase: key?.passphrase ?? "",
        });
    }, [privateKeyData, privateKeyEditorId]);

    function updateForm(patch: Partial<typeof initForm>) {
        setForm((prev) => ({ ...prev, ...patch }));
    }

    function updatePrivateKeyForm(patch: Partial<typeof privateKeyForm>) {
        setPrivateKeyForm((prev) => ({ ...prev, ...patch }));
    }

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
        setPrivateKeyEditorId("");
        setPrivateKeyForm({ name: "", content: "", passphrase: "" });
    }

    async function applyPayload(data: EditServerWindowPayload) {
        setPayload(data);
        const store = useServerDataStore.getState();
        await store.reloadServerData();
        if (data.mode === "edit" && data.serverId) {
            const server = store.findServerDataById(data.serverId);
            if (!server) {
                showToast("服务器不存在", "error");
                return;
            }
            setForm({
                name: server.name,
                ip: server.ip,
                port: server.port,
                user: server.user,
                password: "",
                prkId: server.prkId ?? "",
                groupId: server.groupId || server.group?.id || data.groupId || "root",
            });
            setPasswordVisible(false);
            setAuthMethod(server.prkId ? "privateKey" : "password");
            return;
        }
        setForm({ ...initForm });
        setAuthMethod("password");
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
        if (authMethod === "privateKey" && !form.prkId) {
            showToast("请选择一个私钥", "warning");
            return null;
        }
        return {
            name,
            ip,
            port,
            user,
            password: authMethod === "password" ? form.password : undefined,
            prkId: authMethod === "privateKey" ? form.prkId : undefined,
        };
    }

    function groupHasSameServerName(group: ServerGroupModel, name: string, ignoreId?: string) {
        return group.servers.some((item) => item.id !== ignoreId && item.name === name);
    }

    async function submit(connect: boolean = false) {
        const data = buildServerInput();
        if (!data || !payload) return;
        const store = useServerDataStore.getState();
        let editId = payload.serverId ?? "";
        if (payload.mode === "edit" && payload.serverId) {
            const server = store.findServerDataById(payload.serverId);
            if (!server || !server.group) {
                showToast("服务器不存在", "error");
                return;
            }
            if (groupHasSameServerName(server.group, data.name, server.id)) {
                showToast("服务器名称已存在", "error");
                return;
            }
            server.name = data.name;
            server.ip = data.ip;
            server.port = data.port;
            server.user = data.user;
            if (authMethod === "password") {
                server.prkId = undefined;
                server.password = data.password || server.password;
            } else {
                server.password = undefined;
                server.prkId = data.prkId;
            }
            await store.serverDataChange(server);
        } else {
            const group = currentGroup;
            if (groupHasSameServerName(group, data.name)) {
                showToast("服务器名称已存在", "error");
                return;
            }
            const maxOrder = group.servers.reduce((max, item) => Math.max(max, item.order), 0);
            const serverData = await store.addServerData({ ...data, groupId: group.id, order: maxOrder + 1 }, group);
            editId = serverData?.id ?? "";
        }
        const currentWindow = getCurrentWindow();
        await emitTo<EditServerSavedPayload>({ kind: "Window", label: payload.from }, EDIT_SERVER_SAVED_EVENT, {
            sourceLabel: currentWindow.label,
            editId,
            connect,
        });
        await currentWindow.close();
    }

    function privateKeyNameExists(name: string, ignoreId?: string) {
        return privateKeyData.some((item) => item.id !== ignoreId && item.name === name);
    }

    async function savePrivateKey() {
        const name = privateKeyForm.name.trim();
        const content = privateKeyForm.content.trim();
        if (!name || !content) {
            showToast("请填写私钥名称和内容", "warning");
            return;
        }
        const store = useServerDataStore.getState();
        if (privateKeyEditorId) {
            const key = privateKeyData.find((item) => item.id === privateKeyEditorId);
            if (!key) return;
            if (privateKeyNameExists(name, key.id)) {
                showToast("私钥名称已存在", "error");
                return;
            }
            key.name = name;
            key.content = content;
            key.passphrase = privateKeyForm.passphrase;
            await store.privateKeyChange(key);
            showToast("私钥已更新", "success");
            return;
        }
        if (privateKeyNameExists(name)) {
            showToast("私钥名称已存在", "error");
            return;
        }
        const key = await store.addPrivateKey({ name, content, passphrase: privateKeyForm.passphrase });
        if (key) updateForm({ prkId: key.id });
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
        await useServerDataStore.getState().deletePrivateKey(key);
        if (form.prkId === key.id) updateForm({ prkId: "" });
        if (privateKeyEditorId === key.id) resetPrivateKeyForm();
    }

    function removeEditingPrivateKey() {
        const key = privateKeyData.find((item) => item.id === privateKeyEditorId);
        if (key) void removePrivateKey(key);
    }

    function privateKeyNameFromPath(filePath: string) {
        const base = filePath.split(/[/\\]/).pop() ?? "";
        return base.replace(/\.(pem|key|ppk)$/i, "") || base;
    }

    function looksLikePrivateKey(content: string) {
        return /-----BEGIN\s+(?:OPENSSH\s+|RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+)?PRIVATE KEY-----/.test(content);
    }

    async function pickPrivateKeyFile() {
        const defaultPath = await join(await useAppStore.getState().homeDir, ".ssh");
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
            if (!looksLikePrivateKey(content)) showToast("文件内容不像 SSH 私钥，请确认后保存", "warning");
            updatePrivateKeyForm({
                content,
                name: privateKeyForm.name.trim() ? privateKeyForm.name : privateKeyNameFromPath(selected),
            });
            showToast("已读取私钥文件", "success");
        } catch (err) {
            console.error("read private key file error:", err);
            showToast("读取私钥文件失败", "error");
        }
    }

    return (
        <main className="EditServerWin edit-server-page">
            <header className="edit-server-header">
                <div className="edit-server-title-block">
                    <p className="edit-server-kicker">Edit Server</p>
                    <h1 className="edit-server-title">{modeTitle}</h1>
                </div>
                <GlobalButton bts={["setting", "theme", "themeMode"]} />
            </header>

            <form
                className="edit-server-card edit-server-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit(false);
                }}
            >
                <div className="edit-server-section-title">服务器信息</div>
                <p className="edit-server-group-text">当前分组：{currentGroupName}</p>
                <label className="edit-server-field">
                    <span>名称</span>
                    <SystemInput value={form.name} onChange={(name) => updateForm({ name })} type="text" placeholder="例如：生产服务器" />
                </label>
                <div className="edit-server-grid">
                    <label className="edit-server-field">
                        <span>地址</span>
                        <SystemInput value={form.ip} onChange={(ip) => updateForm({ ip })} type="text" placeholder="IP 或域名" />
                    </label>
                    <label className="edit-server-field">
                        <span>端口</span>
                        <input value={form.port} onChange={(event) => updateForm({ port: toVueModelNumber(event.target.value) })} type="number" min="1" max="65535" />
                    </label>
                </div>
                <label className="edit-server-field">
                    <span>用户</span>
                    <SystemInput value={form.user} onChange={(user) => updateForm({ user })} type="text" placeholder="root" />
                </label>

                <div className="edit-server-section-title">连接方式</div>
                <div className="edit-server-auth-tabs">
                    <button type="button" className={`edit-server-auth-tab${authMethod === "password" ? " active" : ""}`} onClick={() => setAuthMethod("password")}>
                        账户密码
                    </button>
                    <button type="button" className={`edit-server-auth-tab${authMethod === "privateKey" ? " active" : ""}`} onClick={() => setAuthMethod("privateKey")}>
                        账户私钥
                    </button>
                </div>
                {authMethod === "password" ? (
                    <label className="edit-server-field">
                        <span>{isEditingServer ? "新密码" : "密码"}</span>
                        <div className="edit-server-password-wrap">
                            <input value={form.password} onChange={(event) => updateForm({ password: event.target.value })} type={passwordVisible ? "text" : "password"} placeholder={passwordPlaceholder} autoComplete="new-password" />
                            <button className="edit-server-password-toggle" type="button" aria-label={passwordVisible ? "隐藏密码明文" : "显示密码明文"} onClick={() => setPasswordVisible((v) => !v)}>
                                <Icon icon={passwordVisible ? "lucide:eye-off" : "lucide:eye"} />
                            </button>
                        </div>
                        {isEditingServer ? <small>已保存密码不会显示，留空将继续使用原密码。</small> : null}
                    </label>
                ) : (
                    <label className="edit-server-field">
                        <span>私钥</span>
                        <select value={form.prkId} onChange={(event) => updateForm({ prkId: event.target.value })}>
                            <option value="">请选择私钥</option>
                            {privateKeyData.map((key) => (
                                <option key={key.id} value={key.id}>
                                    {key.name}
                                </option>
                            ))}
                        </select>
                        {selectedPrivateKey ? <small>已选择：{selectedPrivateKey.name}</small> : <small>点击底部“私钥管理”新增或维护私钥。</small>}
                    </label>
                )}

                <div className="edit-server-actions">
                    <button className="edit-server-ghost-btn" type="button" onClick={() => setShowPrivateKeyDialog(true)}>
                        私钥管理
                    </button>
                    <button className="edit-server-ghost-btn" type="button" onClick={() => void submit(true)}>
                        保存并连接
                    </button>
                    <button className="edit-server-primary-btn" type="submit">
                        {submitText}
                    </button>
                </div>
            </form>

            {showPrivateKeyDialog ? (
                <div className="edit-server-key-mask" onClick={() => setShowPrivateKeyDialog(false)}>
                    <section className="edit-server-key-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                        <header className="edit-server-key-dialog-head">
                            <div className="edit-server-key-dialog-title-block">
                                <p className="edit-server-kicker">Private Keys</p>
                                <h2 className="edit-server-dialog-title">私钥管理</h2>
                                <p className="edit-server-dialog-subtitle">统一维护 SSH 登录私钥，保存后可在服务器认证方式中选择。</p>
                            </div>
                            <button className="edit-server-icon-btn" type="button" aria-label="关闭私钥管理" onClick={() => setShowPrivateKeyDialog(false)}>
                                <Icon icon="lucide:x" />
                            </button>
                        </header>

                        <div className="edit-server-key-dialog-body">
                            <aside className="edit-server-key-sidebar">
                                <div className="edit-server-key-sidebar-head">
                                    <div>
                                        <span className="edit-server-key-sidebar-title">已保存私钥</span>
                                        <small>{privateKeyData.length} 个</small>
                                    </div>
                                    <button className="edit-server-link-btn" type="button" onClick={resetPrivateKeyForm}>
                                        新增
                                    </button>
                                </div>
                                <div className="edit-server-key-list">
                                    {privateKeyData.map((key) => (
                                        <button key={key.id} type="button" className={`edit-server-key-item${privateKeyEditorId === key.id ? " active" : ""}`} onClick={() => setPrivateKeyEditorId(key.id)}>
                                            <span className="edit-server-key-item-name">{key.name}</span>
                                            <span className="edit-server-key-item-action">
                                                <Icon icon="lucide:pencil" />
                                            </span>
                                        </button>
                                    ))}
                                    {!privateKeyData.length ? (
                                        <div className="edit-server-key-empty">
                                            <Icon icon="lucide:key-round" />
                                            <p className="edit-server-empty-text">还没有保存私钥</p>
                                            <small>在右侧填写名称和私钥内容后保存，或从文件导入。</small>
                                        </div>
                                    ) : null}
                                </div>
                            </aside>

                            <section className="edit-server-key-editor">
                                <div className="edit-server-key-editor-head">
                                    <div>
                                        <span>{privateKeyEditorTitle}</span>
                                        <small>{privateKeyEditorId ? "正在修改已保存私钥" : "创建一个新的 SSH 私钥"}</small>
                                    </div>
                                </div>
                                <div className="edit-server-key-meta-grid">
                                    <label className="edit-server-field">
                                        <span>私钥名称</span>
                                        <input value={privateKeyForm.name} onChange={(event) => updatePrivateKeyForm({ name: event.target.value })} type="text" placeholder="例如：公司跳板机" />
                                    </label>
                                    <label className="edit-server-field">
                                        <span>私钥密码</span>
                                        <input value={privateKeyForm.passphrase} onChange={(event) => updatePrivateKeyForm({ passphrase: event.target.value })} type="password" placeholder="可选" />
                                    </label>
                                </div>
                                <label className="edit-server-field edit-server-key-content-field">
                                    <div className="edit-server-key-content-head">
                                        <span>私钥内容</span>
                                        <button className="edit-server-link-btn" type="button" onClick={() => void pickPrivateKeyFile()}>
                                            从文件选择
                                        </button>
                                    </div>
                                    <textarea value={privateKeyForm.content} onChange={(event) => updatePrivateKeyForm({ content: event.target.value })} rows={10} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                                </label>
                                <div className="edit-server-key-actions">
                                    {privateKeyEditorId ? (
                                        <button className="edit-server-danger-btn" type="button" onClick={removeEditingPrivateKey}>
                                            删除
                                        </button>
                                    ) : null}
                                    <button className="edit-server-primary-btn" type="button" onClick={() => void savePrivateKey()}>
                                        保存私钥
                                    </button>
                                </div>
                            </section>
                        </div>
                    </section>
                </div>
            ) : null}
        </main>
    );
}
