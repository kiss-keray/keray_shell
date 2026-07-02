"use client";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import SystemInput from "@/components/SystemInput";
import { initialState, useConfigStore, type ConfigModel, type ServerRemoteData } from "@/stores/config";
import { useServerDataStore } from "@/stores/serverData";
import type { SettingsTab } from "@/types/settings";
import { invoke } from "@/utils/project";
import { showToast } from "@/utils/ui";
import "./index.scss";

type LocalFont = {
    name: string;
    has_latin: boolean;
    has_cjk: boolean;
    is_monospace: boolean;
};

type LocalFontsPayload = {
    default_english_font: string;
    default_chinese_font: string;
    fonts: LocalFont[];
};

export type SettingDialogProps = {
    activeTab: SettingsTab;
    onActiveTabChange: (tab: SettingsTab) => void;
};

const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: "常规" },
    { id: "appearance", label: "外观" },
    { id: "layout", label: "布局" },
    { id: "terminal", label: "终端" },
    { id: "server", label: "服务器" },
    { id: "about", label: "关于" },
];

function sortFontByName(a: LocalFont, b: LocalFont) {
    return a.name.localeCompare(b.name);
}

function sortEnglishFonts(a: LocalFont, b: LocalFont) {
    if (a.is_monospace !== b.is_monospace) return a.is_monospace ? -1 : 1;
    return sortFontByName(a, b);
}

function ensureSelectedFont(fonts: LocalFont[], selected: string, flags: Pick<LocalFont, "has_latin" | "has_cjk">) {
    const options = [...fonts];
    if (selected && !options.some((font) => font.name === selected)) {
        options.unshift({ name: selected, is_monospace: false, ...flags });
    }
    return options;
}

function toVueModelNumber(value: string): number {
    // Vue v-model.number 在空字符串等无法解析的值上会保留原字符串；这里按运行时行为对齐。
    const parsed = parseFloat(value);
    return (Number.isNaN(parsed) ? value : parsed) as unknown as number;
}

function snapshotConfig(): ConfigModel {
    const config = useConfigStore.getState();
    return {
        theme: config.theme,
        themeMode: config.themeMode,
        fontSize: config.fontSize,
        downloadDir: config.downloadDir,
        compactMode: config.compactMode,
        overviewWidthPx: config.overviewWidthPx,
        sftpPanelHeightPx: config.sftpPanelHeightPx,
        sftpTreeWidthPx: config.sftpTreeWidthPx,
        termFontSize: config.termFontSize,
        termLineHeight: config.termLineHeight,
        termFontFamily: config.termFontFamily,
        termScrollback: config.termScrollback,
        serverSyncKey: config.serverSyncKey,
        serverSyncType: config.serverSyncType,
        serverSyncData: config.serverSyncData,
        autoServerSync: config.autoServerSync,
    };
}

export default function SettingDialog({ activeTab, onActiveTabChange }: SettingDialogProps) {
    const loadFalg = useConfigStore((state) => state.loadFalg);
    const [draft, setDraft] = useState<ConfigModel>({ ...initialState });
    const [terminalFonts, setTerminalFonts] = useState<LocalFont[]>([]);
    const [englishTermFont, setEnglishTermFont] = useState("");
    const [chineseTermFont, setChineseTermFont] = useState("");
    const [defaultEnglishTermFont, setDefaultEnglishTermFont] = useState("");
    const [defaultChineseTermFont, setDefaultChineseTermFont] = useState("");
    const [fontsLoading, setFontsLoading] = useState(false);
    const [fontLoadError, setFontLoadError] = useState("");
    const [version, setVersion] = useState("");
    const [serverSyncPath, setServerSyncPath] = useState("");
    const [serverSyncUrl, setServerSyncUrl] = useState("");
    const [remoteSync, setRemoteSync] = useState<ServerRemoteData>({
        ip: "",
        port: 22,
        user: "",
        password: "",
        path: "/home",
    });

    const englishFontOptions = useMemo(() => {
        const fonts = terminalFonts.filter((font) => font.has_latin && !font.has_cjk).sort(sortEnglishFonts);
        return ensureSelectedFont(fonts, englishTermFont, { has_latin: true, has_cjk: false });
    }, [englishTermFont, terminalFonts]);

    const chineseFontOptions = useMemo(() => {
        const fonts = terminalFonts.filter((font) => font.has_cjk).sort(sortFontByName);
        return ensureSelectedFont(fonts, chineseTermFont, { has_latin: true, has_cjk: true });
    }, [chineseTermFont, terminalFonts]);

    const terminalPreviewStyle = useMemo(
        () => ({
            fontFamily: draft.termFontFamily || undefined,
            fontSize: `${draft.termFontSize}px`,
            lineHeight: String(draft.termLineHeight),
        }),
        [draft.termFontFamily, draft.termFontSize, draft.termLineHeight],
    );

    function updateDraft(patch: Partial<ConfigModel>) {
        setDraft((prev) => ({ ...prev, ...patch }));
    }

    function syncTermFontSelectorsFromDraft(nextDraft: ConfigModel, englishDefault = defaultEnglishTermFont, chineseDefault = defaultChineseTermFont) {
        const [english = "", chinese = ""] = nextDraft.termFontFamily.split(",").map((font) => font.trim());
        const nextEnglish = english || englishDefault;
        const nextChinese = chinese || chineseDefault;
        setEnglishTermFont(nextEnglish);
        setChineseTermFont(nextChinese);
        setDraft((prev) => ({ ...prev, termFontFamily: [nextEnglish, nextChinese].filter(Boolean).join(",") }));
    }

    function updateDraftTermFontFamily(english = englishTermFont, chinese = chineseTermFont) {
        updateDraft({ termFontFamily: [english, chinese].filter(Boolean).join(",") });
    }

    useEffect(() => {
        if (!loadFalg) return;
        const next = snapshotConfig();
        setDraft(next);
        setServerSyncPath(next.serverSyncType === "localFile" ? (next.serverSyncData as string) : "");
        setServerSyncUrl(next.serverSyncType === "http" ? (next.serverSyncData as string) : "");
        if (next.serverSyncType === "remoteFile") setRemoteSync(next.serverSyncData as ServerRemoteData);
        syncTermFontSelectorsFromDraft(next);
        // 配置加载完成时只同步一次表单草稿，后续用户输入不能被 store 更新覆盖。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadFalg]);

    useEffect(() => {
        let disposed = false;
        async function loadLocalFonts() {
            setFontsLoading(true);
            setFontLoadError("");
            try {
                const res = await invoke<LocalFontsPayload>("local_fonts");
                if (disposed) return;
                setTerminalFonts(res.fonts);
                setDefaultEnglishTermFont(res.default_english_font);
                setDefaultChineseTermFont(res.default_chinese_font);
                syncTermFontSelectorsFromDraft(useConfigStore.getState().loadFalg ? snapshotConfig() : draft, res.default_english_font, res.default_chinese_font);
            } catch (err) {
                console.error("load local fonts error:", err);
                if (!disposed) setFontLoadError("读取本地字体失败");
            } finally {
                if (!disposed) setFontsLoading(false);
            }
        }
        void loadLocalFonts();
        void getVersion().then((v) => {
            if (!disposed) setVersion(v);
        });
        return () => {
            disposed = true;
        };
        // 字体和版本只在设置窗口挂载时读取一次；draft 用首次加载时的快照即可。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function persistAndSync(): Promise<boolean> {
        if (!draft.downloadDir.trim()) {
            showToast("请填写本地下载保存路径", "error");
            return false;
        }
        useConfigStore.getState().changeConfig({
            ...draft,
            serverSyncData: getServerSyncData(),
        });
        return true;
    }

    async function onApply() {
        if (await persistAndSync()) {
            showToast("设置已保存", "success");
        }
    }

    async function onOk() {
        if (await persistAndSync()) {
            await getCurrentWindow().close();
        }
    }

    function onCancel() {
        void getCurrentWindow().close();
    }

    function getServerSyncData(): string | ServerRemoteData {
        if (draft.serverSyncType === "localFile") return serverSyncPath;
        if (draft.serverSyncType === "http") return serverSyncUrl;
        if (draft.serverSyncType === "remoteFile") return remoteSync;
        return "";
    }

    async function pickDownloadDir() {
        const base = draft.downloadDir.replace(/\/$/, "") || undefined;
        const selected = await open({
            directory: true,
            multiple: false,
            defaultPath: base,
        });
        if (typeof selected === "string" && selected.length) updateDraft({ downloadDir: selected });
    }

    function resetLayoutDraft() {
        const def = initialState;
        updateDraft({
            overviewWidthPx: def.overviewWidthPx,
            sftpPanelHeightPx: def.sftpPanelHeightPx,
            sftpTreeWidthPx: def.sftpTreeWidthPx,
        });
    }

    async function pickLocalSyncFile() {
        const current = serverSyncPath.replace(/\\/g, "/");
        const base = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : undefined;
        const selected = await open({
            title: "选择同步目录",
            directory: true,
            multiple: false,
            defaultPath: base,
        });
        if (typeof selected === "string" && selected.length) setServerSyncPath(selected);
    }

    async function clickUploadServerData() {
        try {
            useConfigStore.setState({
                serverSyncKey: draft.serverSyncKey,
                serverSyncData: getServerSyncData(),
            });
            await useServerDataStore.getState().uploadServerData(draft.serverSyncKey);
            showToast("上传成功", "success");
            useConfigStore.getState().changeConfig({
                serverSyncKey: draft.serverSyncKey,
                serverSyncData: getServerSyncData(),
            });
        } catch (error) {
            showToast(typeof error === "string" ? error : "上传失败", "error");
        }
    }

    async function clickDownloadServerData() {
        try {
            useConfigStore.setState({
                serverSyncKey: draft.serverSyncKey,
                serverSyncData: getServerSyncData(),
            });
            await useServerDataStore.getState().downloadServerData(draft.serverSyncKey);
            showToast("下载成功", "success");
            useConfigStore.getState().changeConfig({
                serverSyncKey: draft.serverSyncKey,
                serverSyncData: getServerSyncData(),
            });
        } catch (error) {
            showToast(typeof error === "string" ? error : "下载失败", "error");
        }
    }

    return (
        <div className="SettingDialog setting-dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="setting-dialog-title" onKeyDown={(event) => event.key === "Escape" && onCancel()}>
            <div data-tauri-drag-region="" className="drag-region" />
            <div className="setting-dialog-body">
                <nav className="setting-dialog-tabs" aria-label="设置分类">
                    {tabs.map((t) => (
                        <button key={t.id} type="button" className={`setting-dialog-tab${activeTab === t.id ? " active" : ""}`} onClick={() => onActiveTabChange(t.id)}>
                            {t.label}
                        </button>
                    ))}
                </nav>
                <div className="setting-dialog-panels">
                    <section style={{ display: activeTab === "general" ? undefined : "none" }} className="setting-panel">
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="dl-dir">
                                本地下载保存路径
                            </label>
                        </p>
                        <div className="setting-row mb-4">
                            <SystemInput id="dl-dir" value={draft.downloadDir} onChange={(downloadDir) => updateDraft({ downloadDir })} type="text" className="setting-input grow" autoComplete="off" />
                            <button type="button" className="setting-btn secondary" onClick={() => void pickDownloadDir()}>
                                选择文件夹
                            </button>
                        </div>
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="font-size">
                                字体大小
                            </label>
                            <input id="font-size" value={draft.fontSize} onChange={(event) => updateDraft({ fontSize: toVueModelNumber(event.target.value) })} type="number" min="8" max="32" className="setting-input setting-input-narrow" />
                        </p>
                    </section>

                    <section style={{ display: activeTab === "appearance" ? undefined : "none" }} className="setting-panel">
                        <p className="setting-field">
                            <span className="setting-label">主题风格</span>
                            <span className="setting-inline">
                                <label>
                                    <input checked={draft.theme === "nt"} onChange={() => updateDraft({ theme: "nt" })} type="radio" value="nt" /> 拟态
                                </label>
                                <label>
                                    <input checked={draft.theme === "glass"} onChange={() => updateDraft({ theme: "glass" })} type="radio" value="glass" /> 毛玻璃
                                </label>
                            </span>
                        </p>
                        <p className="setting-field">
                            <span className="setting-label">明暗</span>
                            <span className="setting-inline">
                                <label>
                                    <input checked={draft.themeMode === "dark"} onChange={() => updateDraft({ themeMode: "dark" })} type="radio" value="dark" /> 深色
                                </label>
                                <label>
                                    <input checked={draft.themeMode === "light"} onChange={() => updateDraft({ themeMode: "light" })} type="radio" value="light" /> 浅色
                                </label>
                            </span>
                        </p>
                        <p className="setting-field">
                            <label className="setting-check">
                                <input checked={draft.compactMode} onChange={(event) => updateDraft({ compactMode: event.target.checked })} type="checkbox" />
                                紧凑布局（减小全局间距）
                            </label>
                        </p>
                    </section>

                    <section style={{ display: activeTab === "layout" ? undefined : "none" }} className="setting-panel">
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="ov-w">
                                概览默认宽度 (px)
                            </label>
                            <input id="ov-w" value={draft.overviewWidthPx} onChange={(event) => updateDraft({ overviewWidthPx: toVueModelNumber(event.target.value) })} type="number" min="200" max="480" className="setting-input setting-input-narrow" />
                        </p>
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="term-h">
                                文件管理默认高度 (px)
                            </label>
                            <input id="term-h" value={draft.sftpPanelHeightPx} onChange={(event) => updateDraft({ sftpPanelHeightPx: toVueModelNumber(event.target.value) })} type="number" min="120" max="800" className="setting-input setting-input-narrow" />
                        </p>
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="tree-w">
                                目录树宽度 (px)
                            </label>
                            <input id="tree-w" value={draft.sftpTreeWidthPx} onChange={(event) => updateDraft({ sftpTreeWidthPx: toVueModelNumber(event.target.value) })} type="number" min="120" max="520" className="setting-input setting-input-narrow" />
                        </p>
                        <p className="setting-actions">
                            <button type="button" className="setting-btn secondary" onClick={resetLayoutDraft}>
                                恢复默认布局
                            </button>
                        </p>
                    </section>

                    <section style={{ display: activeTab === "terminal" ? undefined : "none" }} className="setting-panel">
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="term-fs">
                                字体大小
                            </label>
                            <input id="term-fs" value={draft.termFontSize} onChange={(event) => updateDraft({ termFontSize: toVueModelNumber(event.target.value) })} type="number" min="8" max="32" className="setting-input setting-input-narrow" />
                        </p>
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="term-lh">
                                行高
                            </label>
                            <input id="term-lh" value={draft.termLineHeight} onChange={(event) => updateDraft({ termLineHeight: toVueModelNumber(event.target.value) })} type="number" min="1" max="2" step="0.05" className="setting-input setting-input-narrow" />
                        </p>
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="term-sb">
                                滚动缓冲行数
                            </label>
                            <input id="term-sb" value={draft.termScrollback} onChange={(event) => updateDraft({ termScrollback: toVueModelNumber(event.target.value) })} type="number" min="500" max="99000" step="500" className="setting-input setting-input-narrow" />
                        </p>
                        <div className="setting-field">
                            <span className="setting-label">字体</span>
                            <div className="term-font-preview" style={terminalPreviewStyle}>
                                <div>0123456789 abcdefghABCDEFGH</div>
                                <div>终端中文字体预览</div>
                            </div>
                            <div className="term-font-pickers">
                                <label className="term-font-picker">
                                    <span className="setting-label">英文字体</span>
                                    <select
                                        value={englishTermFont}
                                        className="setting-select term-font-list"
                                        size={10}
                                        disabled={fontsLoading && !englishFontOptions.length}
                                        onChange={(event) => {
                                            setEnglishTermFont(event.target.value);
                                            updateDraftTermFontFamily(event.target.value, chineseTermFont);
                                        }}
                                    >
                                        {fontsLoading && !englishFontOptions.length ? <option value="">正在读取本地字体...</option> : null}
                                        {englishFontOptions.map((font) => (
                                            <option key={font.name} value={font.name}>
                                                {font.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="term-font-picker">
                                    <span className="setting-label">中文字体</span>
                                    <select
                                        value={chineseTermFont}
                                        className="setting-select term-font-list"
                                        size={10}
                                        disabled={fontsLoading && !chineseFontOptions.length}
                                        onChange={(event) => {
                                            setChineseTermFont(event.target.value);
                                            updateDraftTermFontFamily(englishTermFont, event.target.value);
                                        }}
                                    >
                                        {fontsLoading && !chineseFontOptions.length ? <option value="">正在读取本地字体...</option> : null}
                                        {chineseFontOptions.map((font) => (
                                            <option key={font.name} value={font.name}>
                                                {font.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            {fontLoadError ? <span className="setting-hint">{fontLoadError}</span> : null}
                        </div>
                    </section>

                    <section style={{ display: activeTab === "server" ? undefined : "none" }} className="setting-panel setting-server">
                        <p className="setting-field">
                            <label className="setting-label" htmlFor="server-sync-key">
                                同步 key
                            </label>
                            <SystemInput id="server-sync-key" value={draft.serverSyncKey} onChange={(serverSyncKey) => updateDraft({ serverSyncKey })} type="text" className="setting-input setting-input-narrow" autoComplete="off" />
                        </p>
                        <p className="setting-field">
                            <span className="setting-label">同步类型</span>
                            <span className="setting-inline">
                                <label>
                                    <input checked={draft.serverSyncType === "localFile"} onChange={() => updateDraft({ serverSyncType: "localFile" })} type="radio" value="localFile" /> 本地文件
                                </label>
                                <label>
                                    <input checked={draft.serverSyncType === "http"} onChange={() => updateDraft({ serverSyncType: "http" })} type="radio" value="http" /> HTTP
                                </label>
                                <label>
                                    <input checked={draft.serverSyncType === "remoteFile"} onChange={() => updateDraft({ serverSyncType: "remoteFile" })} type="radio" value="remoteFile" /> 远程文件
                                </label>
                            </span>
                        </p>

                        {draft.serverSyncType === "localFile" ? (
                            <div className="setting-sync-panel">
                                <p className="setting-field">
                                    <label className="setting-label" htmlFor="server-sync-path">
                                        本地目录
                                    </label>
                                </p>
                                <div className="setting-row">
                                    <input id="server-sync-path" value={serverSyncPath} onChange={(event) => setServerSyncPath(event.target.value)} type="text" className="setting-input grow" autoComplete="off" placeholder="选择或输入同步文件路径" />
                                    <button type="button" className="setting-btn secondary" onClick={() => void pickLocalSyncFile()}>
                                        选择文件
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        {draft.serverSyncType === "http" ? (
                            <div className="setting-sync-panel">
                                <p className="setting-field">
                                    <label className="setting-label" htmlFor="server-sync-url">
                                        URL 地址
                                    </label>
                                    <input id="server-sync-url" value={serverSyncUrl} onChange={(event) => setServerSyncUrl(event.target.value)} type="url" className="setting-input setting-input-wide" autoComplete="off" placeholder="https://example.com/sync" />
                                    <span className="setting-hint">下载使用 GET 请求，上传使用 POST 请求</span>
                                </p>
                            </div>
                        ) : null}

                        {draft.serverSyncType === "remoteFile" ? (
                            <div className="setting-sync-panel">
                                <div className="setting-sync-remote-grid">
                                    <p className="setting-field">
                                        <label className="setting-label" htmlFor="server-sync-ip">
                                            主机 IP
                                        </label>
                                        <SystemInput id="server-sync-ip" value={remoteSync.ip} onChange={(ip) => setRemoteSync((prev) => ({ ...prev, ip }))} type="text" className="setting-input setting-input-wide" autoComplete="off" placeholder="192.168.1.1" />
                                    </p>
                                    <p className="setting-field">
                                        <label className="setting-label" htmlFor="server-sync-port">
                                            端口
                                        </label>
                                        <input id="server-sync-port" value={remoteSync.port} onChange={(event) => setRemoteSync((prev) => ({ ...prev, port: toVueModelNumber(event.target.value) }))} type="number" min="1" max="65535" className="setting-input setting-input-narrow" />
                                    </p>
                                    <p className="setting-field">
                                        <label className="setting-label" htmlFor="server-sync-user">
                                            用户名
                                        </label>
                                        <SystemInput id="server-sync-user" value={remoteSync.user} onChange={(user) => setRemoteSync((prev) => ({ ...prev, user }))} type="text" className="setting-input setting-input-wide" autoComplete="username" />
                                    </p>
                                    <p className="setting-field">
                                        <label className="setting-label" htmlFor="server-sync-password">
                                            密码
                                        </label>
                                        <input id="server-sync-password" value={remoteSync.password} onChange={(event) => setRemoteSync((prev) => ({ ...prev, password: event.target.value }))} type="password" className="setting-input setting-input-wide" autoComplete="current-password" />
                                    </p>
                                    <p className="setting-field">
                                        <label className="setting-label" htmlFor="server-sync-path">
                                            远程目录
                                        </label>
                                        <SystemInput id="server-sync-path" value={remoteSync.path} onChange={(path) => setRemoteSync((prev) => ({ ...prev, path }))} type="text" className="setting-input setting-input-wide" autoComplete="off" placeholder="/home" />
                                    </p>
                                </div>
                            </div>
                        ) : null}

                        <p className="setting-field">
                            <label className="setting-check">
                                <input checked={draft.autoServerSync} onChange={(event) => updateDraft({ autoServerSync: event.target.checked })} type="checkbox" />
                                自动服务器同步(自动上传、自动下载)
                            </label>
                        </p>
                        <div className="setting-server-actions mt-4">
                            <button type="button" className="setting-btn upload-btn" onClick={() => void clickUploadServerData()}>
                                <Icon icon="lucide:upload" />
                                上传
                            </button>
                            <button type="button" className="setting-btn download-btn" onClick={() => void clickDownloadServerData()}>
                                <Icon icon="lucide:download" />
                                下载
                            </button>
                        </div>
                    </section>

                    <section style={{ display: activeTab === "about" ? undefined : "none" }} className="setting-panel setting-about">
                        <p className="setting-about-name">Keray Shell</p>
                        <p className="setting-about-line">本地 SSH / SFTP 客户端</p>
                        <p className="setting-about-line muted">版本：{version}</p>
                    </section>
                </div>
            </div>
            <footer className="setting-dialog-footer">
                <button type="button" className="setting-btn secondary" onClick={onCancel}>
                    取消
                </button>
                <button type="button" className="setting-btn" onClick={() => void onApply()}>
                    应用
                </button>
                <button type="button" className="setting-btn primary" onClick={() => void onOk()}>
                    确定
                </button>
            </footer>
        </div>
    );
}
