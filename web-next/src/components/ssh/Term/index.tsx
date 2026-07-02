"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/Icon";
import LayoutRowResizer from "@/components/layout/LayoutRowResizer";
import Sftp from "@/components/sftp/Sftp";
import SystemInput, { type SystemInputExpose } from "@/components/SystemInput";
import useBus, { DirectRemotePathEventKey, TermGroupCommandEventKey } from "@/hooks/useBus";
import { useAppStore } from "@/stores/app";
import { useConfigStore } from "@/stores/config";
import { useKeyEventStore } from "@/stores/keyEvent";
import type { ChannelInstance } from "@/stores/channelInstances";
import { useServerDataStore } from "@/stores/serverData";
import { CustomMenusEventKey, DEFAULT_FONT_FAMILY } from "@/utils/constant";
import { copyText, eventHave, readClipboardText } from "@/utils/project";
import { showToast } from "@/utils/ui";
import { openOrFocusSettingsWindow } from "@/utils/window";
import type TermServer from "@/components/ssh/term_server";
import type { TerminalSnapshot } from "@/components/ssh/term_server";
import "./index.scss";

export type TermProps = {
    server: ChannelInstance;
    groupId?: string;
    groupActive?: boolean;
};

type SearchData = {
    text: string;
    index: number;
    show: boolean;
    count: number;
    wholeWord: boolean;
    regex: boolean;
    caseSensitive: boolean;
};

type WebKitGestureEvent = Event & {
    scale?: number;
};

const emptySearchData = (): SearchData => ({
    text: "",
    index: 0,
    show: false,
    count: 0,
    wholeWord: false,
    regex: false,
    caseSensitive: false,
});

export default function Term({ server, groupId, groupActive }: TermProps) {
    const divRef = useRef<HTMLDivElement | null>(null);
    const lineNumber = useRef<HTMLDivElement | null>(null);
    const root = useRef<HTMLDivElement | null>(null);
    const searchInput = useRef<SystemInputExpose | null>(null);
    const panelRoot = useRef<HTMLDivElement | null>(null);
    const termServer = useRef<TermServer | null>(null);
    const selectedText = useRef("");
    const mousePos = useRef({ x: 0, y: 0 });
    const searchDataRef = useRef<SearchData>(emptySearchData());
    const searchIsFocusRef = useRef(false);
    const selectPromptRef = useRef({ show: false, x: 0, y: 0, text: "" });
    const [ready, setReady] = useState(false);
    const [searchData, setSearchData] = useState<SearchData>(() => emptySearchData());
    const [, setSearchIsFocus] = useState(false);
    const [selectPrompt, setSelectPrompt] = useState({ show: false, x: 0, y: 0, text: "" });
    const showTermPanel = useAppStore((state) => state.showTermPanel);
    const showSftpPanel = useAppStore((state) => state.showSftpPanel);
    const termFontSize = useConfigStore((state) => state.termFontSize);
    const termLineHeight = useConfigStore((state) => state.termLineHeight);
    const termFontFamily = useConfigStore((state) => state.termFontFamily);
    const termScrollback = useConfigStore((state) => state.termScrollback);
    const sftpPanelHeightPx = useConfigStore((state) => state.sftpPanelHeightPx);
    const changeConfig = useConfigStore((state) => state.changeConfig);
    const registerKeyEvent = useKeyEventStore((state) => state.register);
    const { emit, on } = useBus();

    const termConfig = useMemo(
        () => ({
            fontSize: termFontSize,
            lineHeight: termLineHeight,
            fontFamily: termFontFamily || DEFAULT_FONT_FAMILY,
            scrollback: termScrollback,
        }),
        [termFontFamily, termFontSize, termLineHeight, termScrollback],
    );

    function updateLineNumbers({ nums, height, fontSize }: { nums: Array<[number, number]>; height: number; fontSize: number }) {
        if (!lineNumber.current) return;
        lineNumber.current.innerHTML = nums.map(([showNum, realNum]) => `<div class="num" style="height:${height}px;font-size:${fontSize}px" line="${realNum}">${showNum}</div>`).join("");
    }

    function termChangeFontSize(add: number) {
        const size = termServer.current?.changeFontSize(add);
        if (size) changeConfig({ termFontSize: size });
    }

    function writeToTerm(cmd: string) {
        void termServer.current?.write(cmd);
    }

    function setSearchDataSync(next: SearchData | ((prev: SearchData) => SearchData)) {
        const value = typeof next === "function" ? next(searchDataRef.current) : next;
        searchDataRef.current = value;
        setSearchData(value);
    }

    function setSelectPromptSync(next: typeof selectPrompt | ((prev: typeof selectPrompt) => typeof selectPrompt)) {
        const value = typeof next === "function" ? next(selectPromptRef.current) : next;
        selectPromptRef.current = value;
        setSelectPrompt(value);
    }

    function setSearchFocusSync(value: boolean) {
        searchIsFocusRef.current = value;
        setSearchIsFocus(value);
    }

    async function ctrlV() {
        const text = await readClipboardText();
        termServer.current?._onData(text);
    }

    function ctrlC() {
        if (!selectedText.current) return;
        void copyText(selectedText.current);
    }

    function termKeydown(e: KeyboardEvent): boolean {
        const target = e.target as HTMLElement;
        if (!root.current?.contains(target)) return false;
        const curl = e.ctrlKey || e.metaKey;
        if (curl) {
            if (e.key === "f") {
                if (!searchDataRef.current.text || selectedText.current) {
                    setSearchDataSync((prev) => ({ ...prev, text: selectedText.current }));
                }
                search();
            } else if (e.key === "v") void ctrlV();
            else if (e.key === "c") ctrlC();
            else if (e.key === "=") termChangeFontSize(1);
            else if (e.key === "-") termChangeFontSize(-1);
            else if (e.key === "0") termChangeFontSize(0);
            else return false;
            return true;
        }
        if (e.key === "Escape") {
            if (searchDataRef.current.show) hideSearch();
            setSelectPromptSync((prev) => ({ ...prev, show: false }));
            return true;
        }
        return false;
    }

    function clickCopyText() {
        void copyText(selectPromptRef.current.text);
        termServer.current?.clearSelection();
    }

    function applyText() {
        void termServer.current?.write(selectPromptRef.current.text);
        termServer.current?.clearSelection();
    }

    function searchOptions(data = searchDataRef.current) {
        return {
            regex: data.regex,
            caseSensitive: data.caseSensitive,
            wholeWord: data.wholeWord,
        };
    }

    function clickSearch(next: boolean, data = searchDataRef.current) {
        const instance = termServer.current;
        if (!instance) return;
        const fn = next ? instance.findNext : instance.findPrevious;
        fn.bind(instance)(data.text, searchOptions(data));
    }

    function focusSearchInput() {
        window.setTimeout(() => searchInput.current?.focus(), 0);
    }

    function search(nextData = searchDataRef.current) {
        const instance = termServer.current;
        if (!instance) return;
        mousePos.current = { x: 0, y: 0 };
        const data = { ...nextData, show: true };
        setSearchDataSync(data);
        instance.clearDecorations();
        clickSearch(true, data);
        focusSearchInput();
    }

    function hideSearch() {
        termServer.current?.clearDecorations();
        setSearchDataSync({ ...searchDataRef.current, text: "", count: 0, show: false });
    }

    function updateSearch(patch: Partial<SearchData>) {
        const data = { ...searchDataRef.current, ...patch };
        search(data);
    }

    function applySearch() {
        const data = { ...searchDataRef.current, text: selectPromptRef.current.text };
        setSearchDataSync(data);
        search(data);
        search(data);
    }

    function openContextMenu(e: MouseEvent) {
        e.preventDefault();
        e.stopPropagation();
        setSelectPromptSync((prev) => ({ ...prev, show: false }));
        document.body.dispatchEvent(
            new CustomEvent(CustomMenusEventKey, {
                bubbles: true,
                detail: {
                    menus: [
                        { label: "复制", disabled: !selectedText.current, handler: ctrlC },
                        { label: "粘贴", handler: () => void ctrlV() },
                        { label: "粘贴选中", disabled: !selectedText.current, handler: applyText },
                        "---",
                        { label: "查找", handler: applySearch },
                        "---",
                        {
                            label: "清空缓存",
                            handler: () => {
                                termServer.current?.clear();
                                if (searchDataRef.current.count > 0) {
                                    termServer.current?.resetSearch();
                                    search();
                                }
                            },
                        },
                        "---",
                        {
                            label: "设置",
                            handler: () => void openOrFocusSettingsWindow("terminal"),
                        },
                    ],
                    target: e,
                },
            }),
        );
    }

    function selectLine(e: React.MouseEvent) {
        const line = parseInt((e.target as HTMLElement).getAttribute("line") || "0");
        termServer.current?.selectLines(line - 1, line - 1);
    }

    function menuLineNumber(e: React.MouseEvent) {
        e.preventDefault();
        const line = parseInt((e.target as HTMLElement).getAttribute("line") || "0");
        termServer.current?.settingZeroLine(line);
    }

    useEffect(() => {
        termServer.current?.settingConfig(termConfig);
    }, [termConfig]);

    useEffect(() => {
        let disposed = false;
        const closeFuns: Array<() => void> = [];

        async function init() {
            const host = divRef.current;
            if (!host) return;
            const { default: TermServerClass } = await import("@/components/ssh/term_server");
            if (disposed) return;
            const instance = new TermServerClass({ server });
            termServer.current = instance;
            closeFuns.push(() => instance.close());
            server.snapshotFn.termData = () => {
                return {
                    termData: instance.snapshot(),
                    webData: {
                        searchData: searchDataRef.current,
                        selectPrompt: selectPromptRef.current,
                        searchIsFocus: searchIsFocusRef.current,
                    },
                } satisfies { termData: TerminalSnapshot; webData: { searchData: SearchData; selectPrompt: typeof selectPrompt; searchIsFocus: boolean } };
            };
            instance.settingConfig(termConfig);
            const snapshot = server.snapshot.termData as { termData: TerminalSnapshot; webData?: { searchData?: SearchData; selectPrompt?: typeof selectPrompt; searchIsFocus?: boolean } } | undefined;
            if (snapshot) {
                delete server.snapshot.termData;
                instance.snapshotReset(snapshot.termData, host);
                if (snapshot.webData?.selectPrompt) setSelectPromptSync(snapshot.webData.selectPrompt);
                if (snapshot.webData?.searchData) {
                    setSearchDataSync(snapshot.webData.searchData);
                    if (snapshot.webData.searchData.text) {
                        clickSearch(true, snapshot.webData.searchData);
                        setSearchDataSync(snapshot.webData.searchData);
                    }
                }
                if (snapshot.webData?.searchIsFocus) {
                    setSearchFocusSync(true);
                    focusSearchInput();
                }
            } else {
                instance.initTerminal(host);
            }
            await instance.connect(!snapshot);
            if (!snapshot) {
                server.server.lastConnectAt = Date.now();
                await useServerDataStore.getState().serverDataChange(server.server);
            }
            instance.onLineNumberChange(updateLineNumbers);
            instance.onKeyEvent(termKeydown);
            instance.onSelectionChange((text) => {
                selectedText.current = text;
                const show = Boolean(text);
                setSelectPromptSync({
                    show: show && Boolean(mousePos.current.x),
                    x: mousePos.current.x,
                    y: mousePos.current.y,
                    text,
                });
            });
            instance.onCwdChange((path) => {
                emit(DirectRemotePathEventKey, { sid: server.sessionId, path });
            });
            instance.onData((command) => {
                // 融合终端中，当前终端的输入通过总线广播到同组其他终端。
                if (!groupId) return;
                emit(TermGroupCommandEventKey, { groupId, command, sessionId: server.sessionId });
            });
            instance.onSearchChange((count, index) => {
                setSearchDataSync((prev) => ({ ...prev, count, index: index + 1 }));
            });
            closeFuns.push(
                on(TermGroupCommandEventKey, (event) => {
                    if (event.groupId !== groupId) return;
                    if (event.sessionId === server.sessionId) return;
                    void instance.write(event.command);
                }),
            );
            const unregister = registerKeyEvent((event) => termKeydown(event as unknown as KeyboardEvent));
            closeFuns.push(unregister);
            setReady(true);
        }

        void init().catch((err) => {
            console.error("init terminal error:", err);
            showToast("终端初始化失败", "error");
        });

        return () => {
            disposed = true;
            closeFuns.forEach((close) => close());
            termServer.current = null;
        };
        // 终端实例与 SSH 会话一一对应，配置变化由单独 effect 下发，避免重建连接。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [server.sessionId]);

    useEffect(() => {
        const rootEl = root.current;
        const termEl = divRef.current;
        if (!rootEl || !termEl) return;
        let gestureScale = 1;
        const onGestureStart = (e: WebKitGestureEvent) => {
            e.preventDefault();
            gestureScale = e.scale ?? 1;
        };
        const onGestureChange = (e: WebKitGestureEvent) => {
            e.preventDefault();
            const scale = e.scale ?? gestureScale;
            // macOS WebKit 的 gesture 事件是增量缩放；按 Vue 版逻辑转成字体大小变化。
            termChangeFontSize(10 * (scale - gestureScale));
            gestureScale = scale;
        };
        const onMouseUp = (e: MouseEvent) => {
            if (eventHave(e, termEl)) {
                mousePos.current = { x: e.clientX, y: e.clientY };
            } else {
                mousePos.current = { x: 0, y: 0 };
            }
        };
        const onContextMenu = (e: MouseEvent) => openContextMenu(e);
        rootEl.addEventListener("gesturestart", onGestureStart);
        rootEl.addEventListener("gesturechange", onGestureChange);
        rootEl.addEventListener("mouseup", onMouseUp);
        termEl.addEventListener("contextmenu", onContextMenu);
        return () => {
            rootEl.removeEventListener("gesturestart", onGestureStart);
            rootEl.removeEventListener("gesturechange", onGestureChange);
            rootEl.removeEventListener("mouseup", onMouseUp);
            termEl.removeEventListener("contextmenu", onContextMenu);
        };
        // Vue 版在 onMounted 中只注册一次 DOM 事件；回调内部通过 refs 读取最新搜索/选中状态。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div ref={panelRoot} className="Term relative flex h-full w-full min-h-0 flex-col overflow-hidden">
            <div style={{ display: showTermPanel || groupId ? undefined : "none" }} className="relative viwer root term-module min-h-0 flex-1 overflow-hidden" ref={root}>
                {!groupId || groupActive ? <div ref={lineNumber} className="line-number" onClick={selectLine} onContextMenu={menuLineNumber} /> : null}
                <div className="term" ref={divRef} />
                <div style={{ display: searchData.show ? undefined : "none" }} className="search">
                    <div className="grow flex justify-between items-center ml-2 left">
                        <Icon icon="si:search-alt-fill" className="mr-1" />
                        {/* 搜索内容需要严格保留用户输入的大小写，避免 macOS/WebKit 按自然语言自动改写。 */}
                        <SystemInput
                            ref={searchInput}
                            value={searchData.text}
                            className="grow w-full"
                            onChange={(value) => updateSearch({ text: value })}
                            onFocus={() => setSearchFocusSync(true)}
                            onBlur={() => setSearchFocusSync(false)}
                        />
                        <Icon
                            icon="mdi:format-lowercase"
                            className={`pointer icon${searchData.caseSensitive ? " active" : ""}`}
                            onClick={() => updateSearch({ caseSensitive: !searchData.caseSensitive })}
                        />
                        <Icon icon="icon-park-solid:word" className={`pointer icon${searchData.wholeWord ? " active" : ""}`} onClick={() => updateSearch({ wholeWord: !searchData.wholeWord })} />
                        <Icon icon="mdi:regex" className={`pointer icon${searchData.regex ? " active" : ""}`} onClick={() => updateSearch({ regex: !searchData.regex })} />
                        <p className="cnt">{searchData.count ? `${searchData.index}/${searchData.count}` : "0"}</p>
                    </div>
                    <div className="flex justify-center items-center">
                        <Icon icon="si:expand-less-fill" className="pointer icon" onClick={() => clickSearch(false)} />
                        <Icon icon="si:expand-more-fill" className="pointer icon" onClick={() => clickSearch(true)} />
                        <Icon icon="si:close-duotone" className="pointer icon" onClick={hideSearch} />
                    </div>
                </div>
                {selectPrompt.show ? (
                    <div className="select-prompt flex" style={{ left: `${selectPrompt.x}px`, top: `${selectPrompt.y + 10}px` }}>
                        <Icon
                            icon="si:copy-alt-duotone"
                            className="pointer icon"
                            onClick={(event) => {
                                event.stopPropagation();
                                clickCopyText();
                            }}
                        />
                        <Icon
                            icon="si:copy-fill"
                            className="pointer icon"
                            onClick={(event) => {
                                event.stopPropagation();
                                applyText();
                            }}
                        />
                        <Icon
                            icon="si:search-alt-fill"
                            className="pointer icon"
                            onClick={(event) => {
                                event.stopPropagation();
                                applySearch();
                            }}
                        />
                    </div>
                ) : null}
            </div>
            {ready && !groupId ? (
                <>
                    <div style={{ display: showSftpPanel && showTermPanel ? undefined : "none" }}>
                        <LayoutRowResizer
                            container={panelRoot}
                            modelValue={sftpPanelHeightPx}
                            // Vue 版拖拽时直接 v-model 到 Pinia ref，不触发配置保存事件。
                            onChange={(value) => useConfigStore.setState({ sftpPanelHeightPx: value })}
                        />
                    </div>
                    <div
                        style={
                            showTermPanel
                                ? {
                                      display: showSftpPanel ? undefined : "none",
                                      height: `${sftpPanelHeightPx}px`,
                                  }
                                : { display: showSftpPanel ? undefined : "none" }
                        }
                        className={!showTermPanel ? "overflow-hidden min-h-0 flex-1" : "overflow-hidden"}
                    >
                        <Sftp className="h-full min-h-0" server={server} writeTerminal={writeToTerm} />
                    </div>
                </>
            ) : null}
        </div>
    );
}
