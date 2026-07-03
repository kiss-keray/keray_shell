<!--
  ServerList.vue — 「快速连接」页：展示最近连接过的服务器，支持搜索与一键打开/复用会话。
  数据来自 serverDataStore；打开行为由 channelInstancesStore 管理（新建 Channel 或切到已有实例）。
-->
<script setup lang="ts">
import { storeToRefs } from "pinia";
import { CHANNEL_INSTANCE_GROUP_CREATE_EVENT, type ChannelInstance, type ChannelInstanceGroupCreatePayload } from "@/stores/channelInstances";
import type { ServerDataModel, ServerGroupModel } from "@/stores/serverData";
import dayjs from "dayjs";
import { emitTo } from "@tauri-apps/api/event";
import { useAppStore } from "@/stores/app";
import type { MenuItem } from "./DefaultMenuItems.vue";
const appStore = useAppStore();
/** 服务器树、最近列表等业务状态 */
const serverDataStore = useServerDataStore();
/** 底部/侧栏 Channel 实例（每个实例对应一个连接 UI） */
const channelInstancesStore = useChannelInstancesStore();
/** 用 storeToRefs 解构，保持 recentlyServerData / serverRootGroup 的响应式 */
const { recentlyServerIds, serverRootGroup } = storeToRefs(serverDataStore);
const { isMultiSelectKey } = storeToRefs(useKeyEventStore());

/** 搜索框关键字，与 serverList 联动筛选 */
const keyword = ref("");

/** 选中服务器列表 */
const selectedServers = ref<ServerDataModel[]>([]);

const recentlyServerData = computed(() => {
    return recentlyServerIds.value.map((id) => serverDataStore.findServerDataById(id, serverRootGroup.value)).filter((v) => v !== null);
});

/**
 * 分组 id → 人类可读路径（如 /办公/测试）。
 * 根节点 id 为 "root" 时路径记为 "/"，子节点在父路径后拼接 /name。
 * 供列表展示与搜索「分组路径」字段使用。
 */
const groupPathMap = computed(() => {
    const map = new Map<string, string>();

    function walk(group: ServerGroupModel, parentPath = "") {
        const currentPath = group.id === "root" ? "/" : `${parentPath === "/" ? "" : parentPath}/${group.name}`;
        map.set(group.id, currentPath);
        group.children.forEach((child) => walk(child, currentPath));
    }

    walk(serverRootGroup.value);
    return map;
});

/**
 * 当前表格要渲染的「最近连接」列表（已去重、已排序、可选按关键字筛选）。
 * - reverse：store 里通常是「新追加在末尾」，界面希望最新在上，故反转。
 * - Set 去重：同一 server.id 若在历史里出现多次，只保留第一次（反转后等价于「最新那条」）。
 * - 筛选：不区分大小写，匹配 name / ip / port / user / 分组路径 任一子串。
 */
const serverList = computed(() => {
    const seen = new Set<string>();
    // 倒序排序，最新在最上面
    const list = [...recentlyServerData.value].reverse().filter((server) => {
        if (seen.has(server.id)) return false;
        seen.add(server.id);
        return true;
    });
    const q = keyword.value.trim().toLowerCase();
    if (!q) return list;
    return list.filter((server) => {
        const groupPath = getGroupPath(server).toLowerCase();
        return [server.name, server.ip, String(server.port), server.user, groupPath].some((text) => text.toLowerCase().includes(q));
    });
});

/** 工具栏右侧统计文案：有搜索词时强调「筛选结果」，否则显示最近连接总数 */
const totalText = computed(() => {
    const count = serverList.value.length;
    return keyword.value.trim() ? `筛选到 ${count} 台` : `${count} 台最近连接`;
});

/** 根据 server.groupId 查分组路径；未知分组回退为 "/" */
function getGroupPath(server: ServerDataModel) {
    return groupPathMap.value.get(server.groupId) ?? "/";
}

function clickServer(server: ServerDataModel) {
    if (isMultiSelectKey.value) {
        if (selectedServers.value.includes(server)) {
            selectedServers.value = selectedServers.value.filter((item) => item.id !== server.id);
        } else {
            selectedServers.value.push(server);
        }
        return;
    }
    channelInstancesStore.clear();
    openServer(server);
}

/**
 * 点击一行：若该服务器已有打开的 Channel，则只切换选中；否则新建实例并加入 store，
 * 同时把该服务器再次记入「最近连接」列表（刷新其在历史中的位置）。
 */
function openServer(server: ServerDataModel) {
    emitTo<ServerTreeClickServerPayload>(
        {
            kind: "Window",
            label: appStore.label,
        },
        SERVER_TREE_CLICK_SERVER_EVENT,
        { id: server.id },
    );
}

/** 清空搜索词 + 清空最近连接记录（与头部「清空」按钮绑定） */
function cleanRecent() {
    keyword.value = "";
    serverDataStore.cleanRecentlyServerData();
}

function openContextMenu(e: MouseEvent, server: ServerDataModel) {
    e.preventDefault();
    e.stopPropagation();
    const menus: MenuItem[] = [
        {
            label: "连接",
            handler: () => {
                channelInstancesStore.clear();
                if (selectedServers.value.length > 0) {
                    selectedServers.value.forEach((item) => {
                        openServer(item);
                    });
                } else {
                    openServer(server);
                }
            },
        },
        {
            label: `融合终端(+${selectedServers.value.length})`,
            handler: () => {
                channelInstancesStore.clear();
                emitTo<ChannelInstanceGroupCreatePayload>(
                    {
                        kind: "Window",
                        label: appStore.label,
                    },
                    CHANNEL_INSTANCE_GROUP_CREATE_EVENT,
                    { ids: selectedServers.value.map((item) => item.id), type: "terminal" },
                );
            },
            disabled: selectedServers.value.length < 2,
        },
        {
            label: `融合监控(+${selectedServers.value.length})`,
            handler: () => {
                channelInstancesStore.clear();
                emitTo<ChannelInstanceGroupCreatePayload>(
                    {
                        kind: "Window",
                        label: appStore.label,
                    },
                    CHANNEL_INSTANCE_GROUP_CREATE_EVENT,
                    { ids: selectedServers.value.map((item) => item.id), type: "monitor" },
                );
            },
            disabled: selectedServers.value.length < 2,
        },
        {
            label: "删除",
            handler: () => {
                if (selectedServers.value.length > 0) {
                    selectedServers.value.forEach((item) => {
                        serverDataStore.deleteRecentlyServerData(item);
                    });
                } else {
                    serverDataStore.deleteRecentlyServerData(server);
                }
            },
        },
    ];
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
}
</script>

<template>
    <div class="server-list-root h-full">
        <!-- 整页容器：占满父级，内边距由主题/布局决定 -->
        <section class="server-list-page">
            <!-- 内容区最大宽度居中，纵向 flex 让列表区域可滚动 -->
            <div class="server-list-shell">
                <!-- 标题区 + 清空最近列表 -->
                <header class="server-list-header">
                    <div>
                        <p class="server-list-kicker">Quick Connect</p>
                        <h1 class="server-list-title">快速连接</h1>
                    </div>
                    <button class="server-list-clear" type="button" :disabled="!recentlyServerData.length" @click="cleanRecent">清空</button>
                </header>

                <!-- 搜索 + 数量统计 -->
                <div class="server-list-toolbar">
                    <label class="server-list-search">
                        <Icon icon="si:search-alt-fill" class="server-list-search-icon" />
                        <SystemInput v-model="keyword" type="search" placeholder="搜索名称、IP、路径或用户" />
                    </label>
                    <span class="server-list-count">{{ totalText }}</span>
                </div>

                <!-- 有数据：表头 + 可点击行（每行一个 button，利于无障碍与整行点击） -->
                <div v-if="serverList.length" class="server-list-card grow">
                    <div class="server-list-head" aria-hidden="true">
                        <span>服务器</span>
                        <span>分组路径</span>
                        <span>用户</span>
                        <span>地址</span>
                        <span>最后连接时间</span>
                    </div>
                    <button
                        v-for="server in serverList"
                        :key="server.id"
                        class="server-list-row"
                        :class="{ 'server-list-row-selected': selectedServers.includes(server) }"
                        type="button"
                        @click="clickServer(server)"
                        @contextmenu="openContextMenu($event, server)"
                    >
                        <span class="server-list-main">
                            <Icon icon="lucide:server" class="server-list-server-icon" />
                            <span class="server-list-name">{{ server.name }}</span>
                        </span>
                        <span class="server-list-path" :title="getGroupPath(server)">{{ getGroupPath(server) }}</span>
                        <span class="server-list-user">{{ server.user }}</span>
                        <span class="server-list-host">{{ server.ip }}:{{ server.port }}</span>
                        <span class="server-list-last-connect-time">{{ server.lastConnectAt ? dayjs(new Date(server.lastConnectAt)).format("YYYY-MM-DD HH:mm:ss") : "--" }}</span>
                    </button>
                </div>

                <!-- 无数据：区分「搜不到」与「本来就没有最近连接」 -->
                <div v-else class="server-list-empty">
                    <span class="server-list-empty-icon" aria-hidden="true"></span>
                    <p class="server-list-empty-title">{{ keyword ? "没有匹配的服务器" : "暂无最近连接" }}</p>
                </div>
            </div>
        </section>
        <GlobalButton :bts="['serverTree', 'setting', 'theme', 'themeMode']" />
    </div>
</template>

<style scoped lang="scss">
/* ---------- 布局：整页 + 居中壳层 ---------- */
.server-list-page {
    width: 100%;
    height: 100%;
    padding: 48px 56px 40px;
    overflow: hidden;
}

/* min-height: 0 让 flex 子项在纵向可收缩，配合列表 overflow:auto 避免撑破父级 */
.server-list-shell {
    width: min(1080px, 100%);
    height: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
}

.server-list-header,
.server-list-toolbar,
.server-list-main,
.server-list-search {
    display: flex;
    align-items: center;
}

.server-list-header {
    justify-content: space-between;
    gap: 16px;
}

.server-list-kicker,
.server-list-title,
.server-list-empty-title {
    margin: 0;
}

.server-list-kicker {
    font-size: var(--font-size-xs);
    letter-spacing: 0.16em;
    text-transform: uppercase;
}

.server-list-title {
    margin-top: 4px;
    font-size: var(--font-size-icon-lg);
    line-height: 1.15;
    font-weight: 700;
}

.server-list-clear {
    height: 32px;
    min-width: 78px;
    padding: 0 16px;
    border-radius: 8px;
    font-size: var(--font-size-md);
    cursor: pointer;

    &:disabled {
        cursor: not-allowed;
    }
}

.server-list-toolbar {
    justify-content: space-between;
    gap: 12px;
}

.server-list-search {
    flex: 1;
    min-width: 0;
    height: 36px;
    gap: 8px;
    padding: 0 12px;
    border-radius: 10px;

    input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        font: inherit;
    }
}

.server-list-search-icon {
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
}

.server-list-count {
    flex: 0 0 auto;
}

/* 列表卡片：唯一纵向滚动区域 */
.server-list-card {
    min-height: 0;
    overflow: auto;
    border-radius: 14px;
}

.server-list-head,
.server-list-row {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(220px, 1.3fr) minmax(180px, 0.9fr) minmax(120px, 0.45fr) minmax(160px, 0.7fr) minmax(160px, 0.7fr);
    gap: 16px;
    align-items: center;
}

/* 表头吸顶，滚动长列表时仍能看到列名 */
.server-list-head {
    position: sticky;
    top: 0;
    z-index: 1;
    min-height: 34px;
    padding: 0 16px;
}

.server-list-row {
    min-height: 46px;
    padding: 0 16px;
    border: 0;
    text-align: left;
    font: inherit;
    cursor: pointer;
}

.server-list-main {
    gap: 9px;
    min-width: 0;
}

.server-list-name,
.server-list-path,
.server-list-user,
.server-list-host {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.server-list-name {
    font-weight: 650;
}

.server-list-empty {
    flex: 1;
    min-height: 220px;
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 8px;
}

.server-list-empty-icon {
    width: 34px;
    height: 34px;
    border-radius: 10px;
}

.server-list-empty-title {
    font-size: var(--font-size-xl);
    font-weight: 650;
}

/* 窄屏：压缩边距、工具栏纵向堆叠、隐藏表头、行改为单列信息块 */
@media (max-width: 760px) {
    .server-list-page {
        padding: 40px 18px 24px;
    }

    .server-list-header,
    .server-list-toolbar {
        align-items: stretch;
        flex-direction: column;
    }

    .server-list-clear {
        width: 100%;
    }

    .server-list-head {
        display: none;
    }

    .server-list-row {
        grid-template-columns: 1fr;
        gap: 4px;
        padding: 10px 12px;
    }

    .server-list-main {
        align-items: flex-start;
        flex-direction: column;
        gap: 2px;
    }
}
</style>
