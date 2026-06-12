<script setup lang="ts">
import { ChannelInstanceProvideKey, CustomMenusEventKey, DEFAULT_FONT_FAMILY } from "@/utils/constant";
import TermServer, { type TerminalSnapshot } from "./term_server";
import "@xterm/xterm/css/xterm.css";
import { storeToRefs } from "pinia";
import type { UnlistenFn } from "@tauri-apps/api/event";
import useBus, { DirectRemotePathEventKey, TermGroupCommandEventKey } from "@/composables/useBus";
import type { SystemInputExpose } from "../SystemInput.vue";

const props = withDefaults(
    defineProps<{
        server: ChannelInstance;
        groupId?: string;
        groupActive?: boolean;
    }>(),
    {
        isGroup: false,
        groupActive: false,
    },
);
const appStore = useAppStore();
const configStore = useConfigStore();
const serverDataStore = useServerDataStore();
const keyEventStore = useKeyEventStore();
const { emit, on, off } = useBus();
const { showSftpPanel, showTermPanel } = storeToRefs(appStore);
const { termFontSize, termLineHeight, termFontFamily, termScrollback, sftpPanelHeightPx } = storeToRefs(configStore);
const { serverDataChange } = serverDataStore;

let termServer: TermServer;

const termReady = ref(false);
function writeToTerm(cmd: string) {
    termServer?.write(cmd);
}

const divRef = ref<HTMLElement>();
const lineNumber = ref<HTMLElement>();
const root = ref<HTMLDivElement>();
const searchInput = ref<SystemInputExpose>();
const panelRoot = ref<HTMLDivElement>();

let selectedText = "";
const mousePos = { x: 0, y: 0 };
const searchData = reactive({
    text: "",
    index: 0,
    show: false,
    count: 0,
    wholeWord: false,
    regex: false,
    caseSensitive: false,
});
const selectPrompt = reactive({
    show: false,
    x: 0,
    y: 0,
    text: "",
});
const searchIsFocus = ref(false);

type DragStartSnapshot = {
    termData: TerminalSnapshot;
    webData: {
        searchData: typeof searchData;
        selectPrompt: typeof selectPrompt;
        searchIsFocus: boolean;
    };
};
const closeFuns: UnlistenFn[] = [];

const termConfig = computed(() => {
    return {
        fontSize: termFontSize.value,
        lineHeight: termLineHeight.value,
        fontFamily: termFontFamily.value || DEFAULT_FONT_FAMILY,
        scrollback: termScrollback.value,
    };
});

watch(
    () => searchData.show,
    (val) => {
        if (!val) {
            searchData.text = "";
            searchData.count = 0;
            termServer.clearDecorations();
        }
    },
);

watch(termConfig, () => {
    termServer?.settingConfig(termConfig.value);
});

// 按esc键
function enterEsc() {
    if (searchData.show) searchData.show = false;
    if (selectPrompt.show) selectPrompt.show = false;
}

function updateLineNumbers({ nums, height, fontSize }: { nums: Array<[number, number]>; height: number; fontSize: number }) {
    let html = "";
    for (const [showNum, realNum] of nums) {
        html += `<div class="num" style="height:${height}px;font-size:${fontSize}px" line="${realNum}">${showNum}</div>`;
    }
    if (!lineNumber.value) return;
    lineNumber.value!.innerHTML = html;
}

function termServerEventListen() {
    termServer.onLineNumberChange(updateLineNumbers);
    // 响应win系统的ctrl+c
    termServer.onKeyEvent(termKeydown);
    termServer.onSelectionChange((text) => {
        selectedText = text;
        selectPrompt.text = selectedText;
        const show = Boolean(selectedText);
        selectPrompt.show = false;
        if (!mousePos.x) return;
        selectPrompt.show = show;
        selectPrompt.x = mousePos.x;
        selectPrompt.y = mousePos.y;
    });
    termServer.onCwdChange((path) => {
        emit(DirectRemotePathEventKey, { sid: props.server.sessionId, path });
    });
    termServer.onData((command) => {
        emit(TermGroupCommandEventKey, { groupId: props.groupId!, command, sessionId: props.server.sessionId });
    });
    termServer.onSearchChange((count, index) => {
        searchData.count = count;
        searchData.index = index + 1;
    });
    closeFuns.push(
        on(TermGroupCommandEventKey, (event) => {
            if (event.groupId !== props.groupId) return;
            if (event.sessionId === props.server.sessionId) return;
            termServer.write(event.command);
        }),
    );
}
function termChangeFontSize(add: number) {
    const size = termServer.changeFontSize(add);
    if (size) {
        configStore.changeConfig({
            termFontSize: size,
        });
    }
}
function domEventListen() {
    {
        let scale = 1;
        root.value!.addEventListener("gesturechange", (e: any) => {
            e.preventDefault();
            termChangeFontSize(10 * (e.scale - scale));
            scale = e.scale;
        });
        root.value!.addEventListener("gesturestart", (e: any) => {
            e.preventDefault();
            scale = e.scale;
        });
    }

    root.value!.addEventListener("mouseup", (e: MouseEvent) => {
        if (eventHave(e, divRef.value!)) {
            mousePos.x = e.clientX;
            mousePos.y = e.clientY;
        } else {
            mousePos.x = 0;
        }
    });
    divRef.value!.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        selectPrompt.show = false;
        document.body.dispatchEvent(
            new CustomEvent(CustomMenusEventKey, {
                bubbles: true,
                detail: {
                    menus: menusConfig.value,
                    target: e,
                },
            }),
        );
    });
    // 响应mac的command
    closeFuns.push(
        keyEventStore.register((e) => {
            return termKeydown(e);
        }),
    );
}

function termKeydown(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement;
    if (!root.value!.contains(target)) return false;
    // 处理部分快捷键
    // command+f
    const curl = e.ctrlKey || e.metaKey;
    if (curl) {
        if (e.key === "f") {
            if (!searchData.text || selectedText) searchData.text = selectedText;
            search();
        } else if (e.key === "v") {
            ctrlV();
        } else if (e.key === "c") {
            ctrlC();
        } else if (e.key === "=") {
            termChangeFontSize(1);
        } else if (e.key === "-") {
            termChangeFontSize(-1);
        } else if (e.key === "0") {
            termChangeFontSize(0);
        } else {
            return false;
        }
        return true;
    } else if (e.key === "Escape") {
        enterEsc();
        return true;
    }
    return false;
}

async function ctrlV() {
    const text = await readClipboardText();
    termServer.write(text);
}

async function ctrlC() {
    if (!selectPrompt.text) return;
    copyText(selectPrompt.text);
}

const clickSearch = (next: boolean) => {
    const options = {
        regex: searchData.regex,
        caseSensitive: searchData.caseSensitive,
        wholeWord: searchData.wholeWord,
    };
    const fun = next ? termServer.findNext : termServer.findPrevious;
    fun.bind(termServer)(searchData.text, options);
};

const search = () => {
    mousePos.x = 0; // 打开搜索时关闭坐标信息 避免粘贴提示显示
    searchData.show = true;
    termServer.clearDecorations();
    clickSearch(true);
    nextTick(() => {
        searchInput.value!.focus();
    });
};

const clickCopyText = () => {
    copyText(selectPrompt.text);
    termServer.clearSelection();
};

const applyText = () => {
    termServer.write(selectPrompt.text);
    termServer.clearSelection();
};

const applySearch = () => {
    searchData.text = selectPrompt.text;
    search();
    search();
};

const selectLine = (e: MouseEvent) => {
    const line = parseInt((e.target as HTMLElement).getAttribute("line") || "0");
    termServer.selectLines(line - 1, line - 1);
};

const menuLineNumber = (e: MouseEvent) => {
    const line = parseInt((e.target as HTMLElement).getAttribute("line") || "0");
    termServer.settingZeroLine(line);
};

onMounted(async () => {
    termServer = new TermServer({ server: props.server });
    closeFuns.push(termServer.close);
    props.server.snapshotFn.termData = () => {
        return {
            termData: termServer.snapshot(),
            webData: {
                searchData: searchData,
                selectPrompt: selectPrompt,
                searchIsFocus: searchIsFocus.value,
            },
        } as DragStartSnapshot;
    };
    termServer.settingConfig(termConfig.value);
    const noSnapshot = !(await sid_new_window_init());
    if (noSnapshot) {
        termServer.initTerminal(divRef.value!);
    }
    await termServer.connect(noSnapshot);
    if (noSnapshot) {
        props.server.server.lastConnectAt = Date.now();
        serverDataChange(props.server.server);
    }
    termServerEventListen();
    domEventListen();
    termReady.value = true;
});

onBeforeUnmount(() => {
    closeFuns.forEach((unlisten) => unlisten());
});

async function sid_new_window_init() {
    const server = props.server;
    const snapshot = server.snapshot.termData as DragStartSnapshot | undefined;
    if (!snapshot) return false;
    const { termData, webData } = snapshot;
    // 快照用了就要删除
    delete server.snapshot.termData;
    termServer.snapshotReset(termData, divRef.value!);
    Object.assign(searchData, webData.searchData);
    Object.assign(selectPrompt, webData.selectPrompt);
    if (searchData.text) {
        clickSearch(true);
        searchData.count = webData.searchData.count;
        searchData.index = webData.searchData.index;
    }
    searchIsFocus.value = webData.searchIsFocus;
    if (searchIsFocus.value) {
        nextTick(() => {
            searchInput.value!.focus();
        });
    }
    return true;
}

const menusConfig = computed(() => {
    return [
        {
            label: "复制",
            disabled: !selectPrompt.text,
            handler: () => {
                ctrlC();
            },
        },
        {
            label: "粘贴",
            handler: async () => {
                ctrlV();
            },
        },
        {
            label: "粘贴选中",
            disabled: !selectPrompt.text,
            handler: () => {
                applyText();
            },
        },
        "---",
        {
            label: "查找",
            handler: () => {
                applySearch();
            },
        },
        "---",
        {
            label: "清空缓存",
            handler: async () => {
                termServer.clear();
                if (searchData.count > 0) {
                    termServer.resetSearch();
                    search();
                }
            },
        },
        "---",
        {
            label: "设置",
            handler: () => {
                openOrFocusSettingsWindow("terminal");
            },
        },
    ];
});

provide(ChannelInstanceProvideKey, props.server);
</script>

<template>
    <div ref="panelRoot" class="relative flex h-full w-full min-h-0 flex-col overflow-hidden">
        <div v-show="showTermPanel || groupId" class="relative viwer root term-module min-h-0 flex-1 overflow-hidden" ref="root">
            <div v-if="!groupId || groupActive" ref="lineNumber" class="line-number" @click="selectLine" @contextmenu="menuLineNumber"></div>
            <div class="term" ref="divRef"></div>
            <div v-show="searchData.show" class="search">
                <div class="grow flex justify-between items-center ml-2 left">
                    <Icon icon="si:search-alt-fill" class="mr-1" />
                    <!-- 搜索内容需要严格保留用户输入的大小写，避免 macOS/WebKit 按自然语言自动改写。 -->
                    <SystemInput ref="searchInput" v-model="searchData.text" class="grow w-full" @input="search" @focus="searchIsFocus = true" @blur="searchIsFocus = false" />
                    <Icon
                        icon="mdi:format-lowercase"
                        class="pointer icon"
                        :class="{ active: searchData.caseSensitive }"
                        @click="
                            searchData.caseSensitive = !searchData.caseSensitive;
                            search();
                        "
                    />
                    <Icon
                        icon="icon-park-solid:word"
                        class="pointer icon"
                        :class="{ active: searchData.wholeWord }"
                        @click="
                            searchData.wholeWord = !searchData.wholeWord;
                            search();
                        "
                    />
                    <Icon
                        icon="mdi:regex"
                        class="pointer icon"
                        :class="{ active: searchData.regex }"
                        @click="
                            searchData.regex = !searchData.regex;
                            search();
                        "
                    />
                    <p class="cnt">
                        {{ searchData.count ? `${searchData.index}/${searchData.count}` : "0" }}
                    </p>
                </div>
                <div class="flex justify-center items-center">
                    <Icon icon="si:expand-less-fill" class="pointer icon" @click="clickSearch(false)" />
                    <Icon icon="si:expand-more-fill" class="pointer icon" @click="clickSearch(true)" />
                    <Icon icon="si:close-duotone" class="pointer icon" @click="searchData.show = false" />
                </div>
            </div>
            <div v-if="selectPrompt.show" class="select-prompt flex" :style="{ left: selectPrompt.x + 'px', top: selectPrompt.y + 10 + 'px' }">
                <Icon icon="si:copy-alt-duotone" class="pointer icon" @click.stop="clickCopyText" />
                <Icon icon="si:copy-fill" class="pointer icon" @click.stop="applyText" />
                <Icon icon="si:search-alt-fill" class="pointer icon" @click.stop="applySearch" />
            </div>
        </div>
        <template v-if="termReady && !groupId">
            <LayoutRowResizer v-show="showSftpPanel && showTermPanel" :container="panelRoot" v-model="sftpPanelHeightPx" />
            <div v-show="showSftpPanel" class="overflow-hidden" :class="{ 'min-h-0 flex-1': !showTermPanel }" :style="showTermPanel ? { height: `${sftpPanelHeightPx}px` } : {}">
                <Sftp class="h-full min-h-0" :server="server" :write-terminal="writeToTerm" />
            </div>
        </template>
    </div>
</template>

<style scoped lang="scss">
.term-module:deep() {
    border-radius: 8px;
    padding: 8px;
    min-height: 0;
    flex: 1 1 0%;

    .line-number {
        margin-top: 8px;
        position: absolute;
        left: 0;
        top: 0;
        z-index: 2;
        width: 34px;
        height: 100%;

        .num {
            cursor: alias;
            display: flex;
            align-items: center;
            justify-content: end;
        }
    }

    .term {
        width: 100%;
        height: 100%;
        padding-left: 30px;

        .xterm-viewport,
        .xterm-scrollable-element {
            background-color: transparent !important;
        }
    }

    .search {
        position: absolute;
        z-index: 2;
        top: 10px;
        right: 10px;
        min-width: 200px;
        max-width: 400px;
        width: 30%;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-radius: 5px;

        .left {
            .icon {
                margin-right: 4px;
            }
        }

        .cnt {
            white-space: nowrap;
            opacity: 1;
            width: 5em;
            text-align: center;
        }

        .icon {
            font-size: var(--font-size-2xl);
            width: 16px;
            height: 16px;
            margin-left: 3px;
        }
    }

    .select-prompt {
        position: fixed;
        z-index: 2000;
        padding: 3px;
        border-radius: 7px;

        .icon {
            font-size: var(--font-size-4xl);
            margin: 0 5px;
            display: inline-block;
        }
    }
    .term {
        .scrollbar {
            width: 6px !important;
            right: -4px !important;
            .slider {
                width: 6px !important;
                border-radius: 3px !important;
            }
        }
    }
}
</style>
