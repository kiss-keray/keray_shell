<script setup lang="ts">
import dayjs from "dayjs";
import type { MenuItem } from "@/components/DefaultMenuItems.vue";
import { CustomMenusEventKey } from "@/utils/constant";
import type { AgentSessionTab } from "./useAgentSessions";
import type { AgentConversationRecord } from "@/agent/types";

/**
 * Agent 顶部多会话栏：标签、新建、历史列表。
 * 右键菜单走全局 CustomMenusEventKey，与终端 Tab 同一套样式。
 */
defineOptions({ name: "AgentSessionBar" });

const props = defineProps<{
    tabs: AgentConversationRecord[];
    activeId: string;
    history: AgentSessionTab[];
    runningIds: string[];
}>();

const emit = defineEmits<{
    select: [id: string];
    create: [];
    close: [id: string];
    "close-others": [id: string];
    "close-all": [];
    "close-completed": [];
    "delete-history": [id: string];
}>();

const rootRef = ref<HTMLElement>();
/** 标签横向滚动容器：激活标签变化后要把对应标签滚进可视区。 */
const tabsRef = ref<HTMLElement>();
const historyOpen = ref(false);
const historyQuery = ref("");

/** 按标题搜索，再按「今天 / 更早」分组；列表本身已按 lastActiveAt 倒序。 */
const filteredHistory = computed(() => {
    const keyword = historyQuery.value.trim().toLowerCase();
    const list = keyword ? props.history.filter((item) => item.title.toLowerCase().includes(keyword)) : props.history;
    const todayStart = dayjs().startOf("day").valueOf();
    return [
        { label: "今天", items: list.filter((item) => item.lastActiveAt >= todayStart) },
        { label: "更早", items: list.filter((item) => item.lastActiveAt < todayStart) },
    ].filter((group) => group.items.length > 0);
});

function formatActiveTime(value: number): string {
    return dayjs(value).format("YYYY-MM-DD HH:mm:ss");
}

/** 右键只提供批量关闭；单标签关闭走标签上的 ×，避免菜单和按钮重复。 */
function openContextMenu(event: MouseEvent, tab: AgentConversationRecord) {
    event.preventDefault();
    event.stopPropagation();
    const menus: MenuItem[] = [
        {
            label: "关闭其他",
            disabled: props.tabs.length <= 1,
            handler: () => emit("close-others", tab.id),
        },
        {
            label: "关闭全部",
            handler: () => emit("close-all"),
        },
        {
            label: "关闭已完成",
            handler: () => emit("close-completed"),
        },
    ];
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: event } }));
}

function toggleHistory() {
    historyOpen.value = !historyOpen.value;
    if (historyOpen.value) historyQuery.value = "";
}

function closeHistory() {
    historyOpen.value = false;
}

function onHistorySelect(id: string) {
    emit("select", id);
    closeHistory();
}

/** 删除不关面板，方便连续清多条；stop 由模板保证，避免点垃圾桶也打开会话。 */
function onHistoryDelete(id: string) {
    emit("delete-history", id);
}

/** 点历史面板外任意处收起下拉，含点到终端区域。 */
function closeOnOutsidePointer(event: PointerEvent) {
    if (!rootRef.value?.contains(event.target as Node)) closeHistory();
}

/**
 * 激活标签变化（新建会话、历史里重开会话都会追加到尾部并激活）后，
 * 等 DOM 更新再把激活标签滚进可视区；inline: "nearest" 保证标签已可见时不乱滚。
 */
watch(
    () => props.activeId,
    async () => {
        await nextTick();
        tabsRef.value
            ?.querySelector(".agent-session-tab.active")
            ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    },
);

onMounted(() => document.addEventListener("pointerdown", closeOnOutsidePointer));
onBeforeUnmount(() => document.removeEventListener("pointerdown", closeOnOutsidePointer));
</script>

<template>
    <header ref="rootRef" class="agent-session-bar">
        <div ref="tabsRef" class="agent-session-tabs" role="tablist" aria-label="Agent 会话">
            <button
                v-for="tab in tabs"
                :key="tab.id"
                type="button"
                class="agent-session-tab"
                :class="{ active: tab.id === activeId, running: runningIds.includes(tab.id) }"
                role="tab"
                :aria-selected="tab.id === activeId"
                :title="tab.title"
                @click="emit('select', tab.id)"
                @contextmenu="openContextMenu($event, tab)"
            >
                <Icon
                    :icon="runningIds.includes(tab.id) ? 'mdi:loading' : 'mdi:message-outline'"
                    :class="{ 'app-loading-spin': runningIds.includes(tab.id) }"
                />
                <span>{{ tab.title }}</span>
                <button
                    v-if="tab.id === activeId"
                    type="button"
                    class="agent-session-tab-close"
                    title="关闭"
                    @click.stop="emit('close', tab.id)"
                >
                    <Icon icon="mdi:close" />
                </button>
            </button>
        </div>

        <div class="agent-session-tools">
            <button type="button" class="agent-session-tool" title="新建会话" @click="emit('create')">
                <Icon icon="mdi:plus" />
            </button>
            <div class="agent-session-history-wrap">
                <button type="button" class="agent-session-tool" title="历史会话" :aria-expanded="historyOpen" @click="toggleHistory">
                    <Icon icon="mdi:history" />
                </button>
                <section v-if="historyOpen" class="agent-session-history" aria-label="历史会话">
                    <input v-model="historyQuery" type="search" placeholder="搜索会话…" />
                    <div class="agent-session-history-list">
                        <p v-if="!filteredHistory.length" class="agent-session-history-empty">暂无历史会话</p>
                        <template v-for="group in filteredHistory" :key="group.label">
                            <p class="agent-session-history-label">{{ group.label }}</p>
                            <div
                                v-for="item in group.items"
                                :key="item.id"
                                class="agent-session-history-row"
                                :class="{ active: item.id === activeId }"
                            >
                                <button type="button" class="agent-session-history-item" @click="onHistorySelect(item.id)">
                                    <Icon
                                        :icon="item.running ? 'mdi:loading' : 'mdi:check-circle-outline'"
                                        :class="{ 'app-loading-spin': item.running }"
                                    />
                                    <span>
                                        <strong>{{ item.title }}</strong>
                                        <small>{{ formatActiveTime(item.lastActiveAt) }}</small>
                                    </span>
                                </button>
                                <!-- 独立按钮避免套在会话按钮里；点删除不应打开会话。 -->
                                <button
                                    type="button"
                                    class="agent-session-history-delete"
                                    title="删除会话"
                                    @click.stop="onHistoryDelete(item.id)"
                                >
                                    <Icon icon="mdi:trash-can-outline" />
                                </button>
                            </div>
                        </template>
                    </div>
                </section>
            </div>
        </div>
    </header>
</template>

<style scoped lang="scss">
.agent-session-bar {
    display: flex;
    min-height: 36px;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 6px;
    box-sizing: border-box;
}
.agent-session-tabs {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
}
.agent-session-tab {
    display: flex;
    max-width: 180px;
    min-width: 72px;
    height: 28px;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-sm);
    > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    > svg {
        flex: none;
        font-size: 15px;
    }
}
.agent-session-tab-close {
    display: inline-flex;
    width: 16px;
    height: 16px;
    flex: none;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-size: 13px;
}
.agent-session-tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
}
.agent-session-tool {
    display: inline-flex;
    width: 28px;
    height: 28px;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    font-size: 18px;
}
.agent-session-history-wrap {
    position: relative;
}
.agent-session-history {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    display: flex;
    width: min(320px, 70vw);
    max-height: min(420px, 70vh);
    flex-direction: column;
    padding: 8px;
    border-radius: 12px;
    box-sizing: border-box;
    input {
        width: 100%;
        height: 32px;
        margin-bottom: 8px;
        padding: 0 10px;
        border: 0;
        border-radius: 8px;
        outline: 0;
        box-sizing: border-box;
        font: inherit;
        font-size: var(--font-size-sm);
    }
}
.agent-session-history-list {
    min-height: 0;
    overflow-y: auto;
}
.agent-session-history-label,
.agent-session-history-empty {
    margin: 6px 8px;
    font-size: var(--font-size-xs);
}
.agent-session-history-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 8px;
}
.agent-session-history-item {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: flex-start;
    gap: 8px;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: inherit;
    > svg {
        flex: none;
        margin-top: 2px;
        font-size: 16px;
    }
    > span {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
        gap: 2px;
    }
    strong,
    small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    strong {
        font-size: var(--font-size-sm);
        font-weight: 500;
    }
    small {
        font-size: var(--font-size-xs);
        font-weight: 400;
    }
}
.agent-session-history-delete {
    display: inline-flex;
    width: 26px;
    height: 26px;
    flex: none;
    align-items: center;
    justify-content: center;
    margin-right: 4px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    font-size: 16px;
    color: inherit;
}
</style>
