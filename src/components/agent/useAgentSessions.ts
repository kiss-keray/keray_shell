import { computed, ref, watch } from "vue";
import { type AgentChatMessage, type AgentContextMemory, type AgentConversationRecord } from "@/agent/types";
import { revokeConversationPreviews } from "@/agent/conversation/attachments";
import { useConversationStorage } from "@/agent/conversation/storage";

const NEW_SESSION_TITLE = "新会话";
const TITLE_MAX = 24;

/** 标签栏和历史列表共用的会话摘要。 */
export interface AgentSessionTab {
    id: string;
    title: string;
    lastActiveAt: number;
    /** 该会话正在流式输出。 */
    running: boolean;
}

/** 用首条用户消息当标题；还没发言时显示「新会话」。 */
function titleFromMessages(messages: AgentChatMessage[]): string {
    const first = messages.find((message) => message.role === "user" && message.content.trim());
    if (!first) return NEW_SESSION_TITLE;
    const text = first.content.trim().replace(/\s+/g, " ");
    return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

/** 新建空白会话；关光标签后也走这条，保证栏里至少有一个可写的空标签。 */
function createSession(projectId: string): AgentConversationRecord {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        projectId,
        title: NEW_SESSION_TITLE,
        createdAt: now,
        lastActiveAt: now,
        messages: [],
    };
}

/**
 * 管理 Agent 多会话标签、历史列表和落盘。
 * 当前激活会话的 messages 与 useAgent 共用同一份数组引用；输入框不跟会话绑定。
 */
export function useAgentSessions(projectId: string) {
    const storage = useConversationStorage();
    // records 含历史正文（含已关标签）；openIds 才是标签栏，关标签只改后者。
    const records = ref<AgentConversationRecord[]>([]);
    // 当前激活的会话id
    const activeId = ref();
    // 所有的会话
    const allTabs = ref<AgentSessionTab[]>([]);
    // 当前打开的会话id
    const openIds = computed(() => records.value.map((item) => item.id));
    // 正在流式输出的会话id
    const runningIds = computed(() => allTabs.value.filter((item) => item.running).map((item) => item.id));
    // 合法的当前激活会话id
    let legalActiveId = "";

    watch(activeId, (newVal) => {
        if (allTabs.value.length && allTabs.value.some((v) => v.id === newVal)) {
            legalActiveId = newVal;
            persistOpenState();
        }
    });

    async function persistOpenState() {
        // openIds也要排除新开的会话
        const _openIds = allTabs.value.filter((item) => openIds.value.includes(item.id)).map((item) => item.id);
        const state = {
            ids: allTabs.value.map((item) => item.id),
            openIds: _openIds,
            activeId: legalActiveId,
        };
        await storage.writeOpenState(projectId, state);
    }

    async function findOrLoadRecord(id: string): Promise<AgentConversationRecord | undefined> {
        const loaded = records.value.find((item) => item.id === id);
        if (loaded) return loaded;
        return storage.read(projectId, id);
    }

    function toTab(record: AgentConversationRecord): AgentSessionTab {
        return {
            id: record.id,
            title: record.title,
            lastActiveAt: record.lastActiveAt,
            running: false,
        };
    }

    /**
     * 加载某个 projectId 下的历史，并恢复上次打开的标签。
     * 思路：磁盘列表为底 → 合入加载期间已发消息的内存会话 → 用 open.json 筛出仍存在的标签。
     * 没有可恢复标签时保留（或新建）一个空 boot，避免栏里一个标签都没有。
     */
    async function loadProject(projectIdValue: string) {
        const listed = await storage.list(projectIdValue);
        const tabStatus = await storage.readOpenState(projectIdValue);
        const ids = tabStatus?.ids ?? [];
        const saveOpendIds = tabStatus?.openIds ?? [];
        const saveActiveId = tabStatus?.activeId ?? listed[0]?.id;
        // 保持顺序
        allTabs.value = ids
            .map((item) => listed.find((v) => v.id === item))
            .filter((item) => item !== undefined)
            .map(toTab);
        records.value = saveOpendIds.map((item) => listed.find((v) => v.id === item)!);
        activeId.value = saveActiveId;
        if (records.value.length === 0) {
            const boot = createSession(projectId);
            records.value = [boot];
            activeId.value = boot.id;
        }
    }

    /** 选择某个会话 */
    async function selectSession(id: string) {
        if (id === activeId.value) return;
        // 如果现在激活的空白会话，选择会话后直接覆盖到空白会话上面
        if (!allTabs.value.some((item) => item.id === activeId.value)) {
            records.value = records.value.filter((item) => item.id !== activeId.value);
        }
        if (!openIds.value.includes(id)) {
            const record = await findOrLoadRecord(id);
            if (!record) return;
            records.value = [...records.value, record];
        }
        activeId.value = id;
    }

    /** 新建一个空会话 */
    async function createSessionTab() {
        const fresh = createSession(projectId);
        records.value = [...records.value, reactive(fresh)];
        activeId.value = fresh.id;
    }

    /**
     * 只从标签栏拿掉，不删历史文件。
     * 关光后必须新建空标签：栏里至少留一个可写会话，且空白标签不进 records 的历史过滤。
     */
    async function closeSession(id: string, persist: boolean = true) {
        const nextActiveIndex = openIds.value.indexOf(id) + 1;
        records.value = records.value.filter((item) => item.id !== id);
        if (id === activeId.value) {
            const nextActive = openIds.value[nextActiveIndex] || openIds.value.at(-1)!;
            activeId.value = nextActive;
        }
        if (openIds.value.length === 0) {
            const fresh = createSession(projectId);
            records.value = [fresh];
            activeId.value = fresh.id;
        }
        if (persist) {
            await persistOpenState();
        }
    }

    /** 只保留右键那一个标签，其它退回历史，文件不删。 */
    async function closeOthers(id: string) {
        activeId.value = id;
        for (const _id of openIds.value) {
            if (_id !== id) {
                await closeSession(_id, false);
            }
        }
        await persistOpenState();
    }

    /** 标签栏清空后新建一个空会话；有消息的记录仍留在 records 供历史列表使用。 */
    async function closeAll() {
        for (const id of openIds.value) {
            await closeSession(id, false);
        }
        await persistOpenState();
    }

    /**
     * 从历史列表和磁盘彻底删除会话（关标签只是藏起来，这条才会清文件和附件副本）。
     * 删的是当前/最后一个打开标签时，补一个空会话，保证栏里始终有可写标签。
     */
    async function deleteSession(id: string) {
        if (runningIds.value.includes(id)) {
            // 正在流式输出的会话不能删除
            return;
        }
        const deleting = await findOrLoadRecord(id);
        if (deleting) revokeConversationPreviews(deleting.messages);
        await storage.remove(projectId, id);
        records.value = records.value.filter((item) => item.id !== id);
        if (openIds.value.length === 0) {
            const fresh = createSession(projectId);
            records.value = [fresh];
        }
        activeId.value = openIds.value.at(-1)!;
        allTabs.value = allTabs.value.filter((item) => item.id !== id);
        await persistOpenState();
    }

    /** 关掉已有消息且当前没在跑的标签；全关光时退回 closeAll，保证仍有一个空标签。 */
    async function closeCompleted() {
        const closeIds = openIds.value.filter((item) => !runningIds.value.includes(item));
        const keep = runningIds.value;
        if (keep.length === 0) {
            await closeAll();
            return;
        }
        selectSession(keep.at(-1)!);
        for (const id of closeIds) {
            await closeSession(id, false);
        }
        await persistOpenState();
    }

    async function saveSession(id: string, messages: AgentChatMessage[], status: boolean, contextMemory?: AgentContextMemory) {
        const record = await findOrLoadRecord(id);
        if (!record) return;
        record.messages = messages;
        if (contextMemory) record.contextMemory = contextMemory;
        record.title = titleFromMessages(messages);
        record.lastActiveAt = Date.now();
        record.projectId = projectId;
        let tab = allTabs.value.find((item) => item.id === id);
        // 新会话要加入 allIds
        if (!tab) {
            if (activeId.value === id) {
                legalActiveId = activeId.value;
            }
            tab = toTab(record);
            allTabs.value = [...allTabs.value, tab];
        }
        tab.running = status;
        storage.write(record);
        await persistOpenState();
    }

    onMounted(() => {
        loadProject(projectId);
    });

    return {
        activeId,
        allTabs,
        oepnTabs: records,
        selectSession,
        createSessionTab,
        closeSession,
        closeOthers,
        closeAll,
        closeCompleted,
        deleteSession,
        saveSession,
    };
}
