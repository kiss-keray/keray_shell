import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import type { IBufferRange, ITerminalInitOnlyOptions, ITerminalOptions } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import type { ISearchOptions } from "@xterm/addon-search";
import { SearchAddon } from "@xterm/addon-search";
import { invoke } from "../../utils/project";
import type { ChannelInstance } from "../../stores/channelInstances";
import { SerializeAddon } from "@xterm/addon-serialize";
import { resolveRemoteHome } from "@/utils/fsUtil";
import { normalizePosixPath, parseOsc7Cwd, terminalDataToString } from "@/utils/termCwd";
import { DEFAULT_FONT_FAMILY } from "@/utils/constant";
import { setChannelInstanceStatus } from "@/stores/channelInstances";
const searchOptions: ISearchOptions = {
    decorations: {
        matchOverviewRuler: "yellow",
        activeMatchColorOverviewRuler: "blue",
        matchBackground: "yellow",
        activeMatchBackground: "blue",
    },
};

export type TermConfig = {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    scrollback: number;
    letterSpacing: number;
    allowProposedApi: boolean;
};

/** 与 Pinia 中终端偏好同步，供新建终端与设置弹窗使用 */
export interface TerminalSnapshot {
    options: ITerminalOptions & ITerminalInitOnlyOptions;
    buffer: string;
    select?: IBufferRange;
    offsety: number;
}
export default class TermServer {
    private readonly server: ChannelInstance;
    private fitAddon: FitAddon;
    private searchAddon: SearchAddon;
    private serializeAddon: SerializeAddon;
    private terminal: Terminal | null = null;
    private pingTask: ReturnType<typeof setTimeout> | undefined;
    private zeroLineNumber: number = 0;
    private currentCwd = "/";
    private homeDir = "/";
    private selectedText: string | null = null;

    private lineNumberChangeFun: VoidFunction = () => {};
    private keyEventFun: (e: KeyboardEvent) => boolean = () => false;
    private cwdChangeCallback: ((path: string) => void) | null = null;
    private onDataCallback: ((data: string) => void) | null = null;
    private onSearchChangeCallback: ((count: number, index: number) => void) | null = null;

    //
    private _lastChangeFontSizeTime: number = 0;

    private termConfig: TermConfig = {
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: 12,
        letterSpacing: 0,
        lineHeight: 1.2,
        allowProposedApi: true,
        scrollback: 5000,
    };
    private pty_config = {
        term: "xterm-256color",
        col_width: 120,
        row_height: 80,
        pix_width: 0,
        pix_height: 0,
    };

    constructor({ server }: { server: ChannelInstance }) {
        this.server = server;
        this.fitAddon = new FitAddon();
        this.searchAddon = new SearchAddon();
        this.serializeAddon = new SerializeAddon();
        this._ping();
    }

    _ps(): {
        serverId: string;
        sid: string;
    } {
        return {
            serverId: this.server.server.id,
            sid: this.server.sessionId,
        };
    }

    _active(): boolean {
        return this.server.status === "connected";
    }

    _ping() {
        this.pingTask = setTimeout(async () => {
            if (this._active()) await invoke("ping", this._ps());
            this._ping();
        }, 20000);
    }

    _fit() {
        this.fitAddon.fit();
        this.pty_config.col_width = this.terminal!.cols;
        this.pty_config.row_height = this.terminal!.rows;
    }

    settingConfig(p: Partial<TermConfig>): void {
        if (p.fontFamily !== undefined) this.termConfig.fontFamily = p.fontFamily;
        if (p.fontSize !== undefined) this.termConfig.fontSize = Math.max(8, Math.min(32, p.fontSize));
        if (p.lineHeight !== undefined) this.termConfig.lineHeight = Math.max(1, Math.min(2, p.lineHeight));
        if (p.scrollback !== undefined) this.termConfig.scrollback = Math.max(100, Math.min(100000, p.scrollback));
        if (!this.terminal) return;
        const t = this.terminal;
        t.options.fontSize = this.termConfig.fontSize;
        t.options.lineHeight = this.termConfig.lineHeight;
        t.options.fontFamily = this.termConfig.fontFamily;
        t.options.scrollback = this.termConfig.scrollback;
        this._fit();
    }

    initTerminal(dom: HTMLElement, options?: ITerminalOptions & ITerminalInitOnlyOptions) {
        const terminal = new Terminal({
            ...this.termConfig,
            ...options,
        });
        this.terminal = terminal;
        terminal.loadAddon(this.fitAddon);
        terminal.loadAddon(this.searchAddon);
        terminal.loadAddon(this.serializeAddon);
        terminal.open(dom);
        terminal.onData(this._onData.bind(this));
        terminal.onKey(({ domEvent }) => {
            if (this.keyEventFun(domEvent)) {
                domEvent.stopPropagation();
                domEvent.preventDefault();
            }
        });
        this._fit();
        this.pty_config.col_width = terminal.cols;
        this.pty_config.row_height = terminal.rows;
        {
            let last_time = 0;
            let last_time1 = 0;
            // 当容器尺寸变化时重新 fit
            const observer = new ResizeObserver(() => {
                const now = new Date().getTime();
                last_time1 = now;
                // 释放鼠标后才更新后端
                setTimeout(() => {
                    if (last_time1 === now && this._active()) {
                        invoke("resize_pty", {
                            ...this._ps(),
                            pty: this.pty_config,
                        });
                    }
                }, 100);
                // 大于50毫秒fit一次
                if (now - last_time < 50) return;
                last_time = now;
                this._fit();
            });
            observer.observe(dom);
        }
        this.bindSearchAddon();
    }

    public async connect(noSnapshot: boolean = true): Promise<void> {
        const readerChannel = new Channel<string | Uint8Array<ArrayBufferLike>>();
        setChannelInstanceStatus(this.server, "connecting");
        if (noSnapshot) this.terminal!.write("连接中...\r\n");
        readerChannel.onmessage = (message) => {
            if (message.length === 1 && message[0] === 0) {
                // 连接断开
                setChannelInstanceStatus(this.server, "disconnected");
                return;
            }
            this.terminal!.write(message);
            const text = terminalDataToString(message);
            for (const path of parseOsc7Cwd(text, this.homeDir)) {
                this._setCwd(path);
            }
        };
        await invoke("open_ssh", {
            ...this._ps(),
            reader: readerChannel,
            pty: this.pty_config,
        })
            .then(async () => {
                setChannelInstanceStatus(this.server, "connected");
                try {
                    const home = await resolveRemoteHome(this.server.server.id);
                    this.homeDir = normalizePosixPath(home);
                    this.currentCwd = this.homeDir;
                } catch {
                    this.homeDir = "/";
                    this.currentCwd = "/";
                }
            })
            .catch(() => {
                setChannelInstanceStatus(this.server, "disconnected");
                if (noSnapshot) this.terminal!.write("连接失败\r\n");
            });
    }

    close() {
        try {
            clearTimeout(this.pingTask);
        } catch {}
    }

    resetSearch() {
        // 清空后如果搜索打开的 重置搜索
        this.clearDecorations();
        this.searchAddon.dispose();
        this.searchAddon = new SearchAddon();
        this.terminal!.loadAddon(this.searchAddon);
        this.bindSearchAddon();
    }

    clearSelection() {
        this.terminal!.clearSelection();
    }

    clearDecorations() {
        // findNext("")才会清除搜索结果
        this.searchAddon.findNext("");
    }

    clear() {
        this.terminal!.clear();
    }

    selectLines(start: number, end: number) {
        this.terminal!.selectLines(start, end);
    }

    findNext(term: string, options?: ISearchOptions) {
        this.searchAddon.findNext(term, {
            ...searchOptions,
            ...options,
        });
    }

    findPrevious(term: string, options?: ISearchOptions) {
        this.searchAddon.findPrevious(term, {
            ...searchOptions,
            ...options,
        });
    }

    async write(cmd: string) {
        invoke("write_cmd", { ...this._ps(), cmd });
        this.foucus();
    }

    changeFontSize(add: number): number | null {
        const sizex = this.terminal!.options.fontSize!;
        // 默认10px
        if (add === 0) add = 10 - sizex;
        const size = Math.max(8, Math.min(32, sizex + add));
        // 间隔60毫秒调一次  避免过于频繁
        const now = new Date().getTime();
        if (now - this._lastChangeFontSizeTime < 60) return null;
        this._lastChangeFontSizeTime = now;
        this.terminal!.options.fontSize = size;
        this._fit();
        return size;
    }

    // 手动降某一行设置为原点
    settingZeroLine(lineNunber: number) {
        this.zeroLineNumber = this.zeroLineNumber === lineNunber ? 0 : lineNunber;
        this.lineNumberChangeFun();
    }

    foucus() {
        this.terminal!.focus();
    }

    snapshot(): TerminalSnapshot {
        const terminal = this.terminal!;
        return {
            options: terminal.options,
            buffer: this.serializeAddon.serialize(), // 终端缓存
            select: terminal.getSelectionPosition(), // 当前选中的位置
            offsety: terminal.buffer.active.viewportY, // 获取首行位置
        };
    }

    snapshotReset(snapshot: TerminalSnapshot, dom: HTMLElement) {
        this.initTerminal(dom, snapshot.options);
        const terminal = this.terminal!;
        terminal.write(snapshot.buffer, () => {
            terminal.scrollToLine(snapshot.offsety);
            if (snapshot.select) {
                const { start: s, end: e } = snapshot.select;
                let start = s;
                if (s.y === e.y && s.x > e.x) start = e;
                else if (s.y > e.y) start = e;
                const end = start === e ? s : e;
                if (s.y === e.y) {
                    terminal.select(start.x, start.y, end.x - start.x);
                } else {
                    const cols = terminal.cols;
                    const len = (end.y - start.y - 1) * cols + (cols - start.x) + end.x;
                    terminal.select(start.x, start.y, len);
                }
            }
        });
        // 快照恢复的写入内容后重新fit一次并通知后端
        setTimeout(() => {
            this._fit();
            invoke("resize_pty", {
                ...this._ps(),
                pty: this.pty_config,
            });
        }, 50);
    }

    _onData(data: string) {
        this.lineNumberChangeFun();
        // 如果是ctrl+c 并且有选择文本 不处理
        if (data === "\u0003" && this.selectedText) {
            return;
        }
        this.onDataCallback?.(data);
        try {
            invoke("write_cmd", { ...this._ps(), cmd: data });
        } catch {
            this.connect();
        }
    }

    private _setCwd(path: string) {
        const normalized = normalizePosixPath(path);
        if (normalized === this.currentCwd) return;
        this.currentCwd = normalized;
        this.cwdChangeCallback?.(normalized);
    }

    // 监听
    onLineNumberChange(calll: (p: { nums: Array<[number, number]>; height: number; fontSize: number }) => void) {
        this.lineNumberChangeFun = () => {
            // @ts-ignore
            const lineHeight = this.terminal._core._renderService.dimensions.css.cell.height;
            const activeNums = this.pty_config.row_height;
            let sn = this.terminal!.buffer.active.viewportY + 1;
            const zero = this.zeroLineNumber;
            sn = sn - zero;
            const nums: Array<[number, number]> = [];
            for (let i = 0; i < activeNums; i++) {
                nums.push([Math.abs(sn + i), sn + zero + i]);
            }
            calll({
                nums,
                height: lineHeight,
                fontSize: Math.min(14, this.termConfig.fontSize * 0.7),
            });
        };
        this.terminal!.onResize(this.lineNumberChangeFun);
        this.terminal!.onRender(this.lineNumberChangeFun);
    }

    onSelectionChange(selectionChangeFun: (text: string) => void) {
        this.terminal!.onSelectionChange(() => {
            const text = this.terminal!.getSelection();
            // 延迟赋值到this
            setTimeout(() => {
                this.selectedText = text;
            }, 60);
            selectionChangeFun(text);
        });
    }

    onSearchChange(call: (count: number, index: number) => void) {
        this.onSearchChangeCallback = call;
    }

    onKeyEvent(call: (e: KeyboardEvent) => boolean) {
        this.keyEventFun = call;
    }

    onCwdChange(call: (path: string) => void) {
        this.cwdChangeCallback = call;
    }

    onData(call: (data: string) => void) {
        this.onDataCallback = call;
    }

    private bindSearchAddon() {
        this.searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
            this.onSearchChangeCallback?.(resultCount, resultIndex);
        });
    }
}
