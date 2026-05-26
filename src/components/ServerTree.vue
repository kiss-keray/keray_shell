<script setup lang="ts">
/**
 * 服务器树视图：以「分组 → 子分组 / 服务器」的扁平行列表渲染整棵目录树。
 * - 正常模式：按 expandedGroupIds 决定是否递归展开子节点。
 * - 搜索模式：不依赖展开状态，只展示与关键词相关的分组行 + 匹配的服务器行（祖先链通过 includeAll 保留）。
 */
import { storeToRefs } from "pinia";
import type { RowData, ServerGroupModel } from "@/stores/serverData";
import { RUNTIME_CACHE_FILE } from "@/stores/localstore";
import type { UnlistenFn } from "@tauri-apps/api/event";

const serverDataStore = useServerDataStore();
const localStore = useLocalStore();
const { serverRootGroup } = storeToRefs(serverDataStore);

/** 搜索框内容；有内容时走 buildSearchRows，否则走 buildRows。 */
const keyword = ref("");
/**
 * 当前展开的分组 id 集合。默认含 root，保证根分组可见；
 * collapseAll 会重置为仅 root，避免整棵树完全消失。
 */
const expandedGroupIds = ref(new Set<string>());
/** 多选模式下被选中的服务器 id（单击带多选键时累加/取消）。 */
const selectedRawData = ref<Set<RowData>>(new Set());
/** 剪切板数据 */
const copyData = ref<{
    type: "copy" | "cut";
    data: RowData[];
}>({ type: "copy", data: [] });

const serverTreeBodyRef = ref<HTMLDivElement | null>(null);

const closeFuns: UnlistenFn[] = [];

/** 整棵树（含嵌套分组）下的服务器总数，用于工具栏展示。 */
const showServerCount = computed(() => {
    let count = 0;
    treeForEach<ServerGroupModel>(serverRootGroup.value, (group: ServerGroupModel) => {
        count += group.servers.length;
    });
    return count;
});

/** 区分「库为空」与「有数据但搜索无结果」，供空状态文案使用。 */
const emptyText = computed(() => (keyword.value.trim() ? "没有匹配的服务器或分组" : "暂无服务器"));

watch(
    expandedGroupIds,
    (newVal) => {
        localStore.writeCache("EXPANDED_GROUP_IDS", Array.from(newVal), RUNTIME_CACHE_FILE);
    },
    { deep: true },
);

/** 遍历树收集全部分组 id 并写入展开集合，使 buildRows 能递归渲染整棵树。 */
function expandAll() {
    const next = new Set<string>();
    treeForEach<ServerGroupModel>(serverRootGroup.value, (group: ServerGroupModel) => {
        next.add(group.id);
    });
    expandedGroupIds.value = new Set(next);
}

/** 只保留 root 展开，其余折叠；root 必须保留否则浏览模式下子树无从挂载显示。 */
function collapseAll() {
    expandedGroupIds.value = new Set([serverRootGroup.value.id]);
}

function clearSelectedRows() {
    selectedRawData.value = new Set();
}

onMounted(() => {
    expandedGroupIds.value.add(serverRootGroup.value.id);
    localStore.readCache<string[]>("EXPANDED_GROUP_IDS", RUNTIME_CACHE_FILE).then((data) => {
        if (data) {
            expandedGroupIds.value = new Set(data);
        }
    });
    document.body.addEventListener("click", clearSelectedRows);
});

onUnmounted(() => {
    document.body.removeEventListener("click", clearSelectedRows);
});

dragListener(() => {
    return Array.from(serverTreeBodyRef.value?.querySelectorAll(".server-tree-row") ?? []);
}).then((unlisten) => {
    closeFuns.push(unlisten);
});
</script>

<template>
    <div class="server-tree-root h-full">
        <!-- 整页：顶栏、搜索、表格卡片或空状态 -->
        <section class="server-tree-page">
            <header class="server-tree-header">
                <div class="server-tree-title-block">
                    <p class="server-tree-kicker">Server Tree</p>
                    <h1 class="server-tree-title">服务器连接</h1>
                </div>
                <div class="server-tree-actions">
                    <button class="server-tree-action" type="button" @click="expandAll">全部展开</button>
                    <button class="server-tree-action" type="button" @click="collapseAll">全部收起</button>
                </div>
            </header>

            <div class="server-tree-toolbar">
                <label class="server-tree-search">
                    <Icon icon="si:search-alt-fill" class="server-tree-search-icon" />
                    <input v-model="keyword" type="search" placeholder="搜索分组、名称、IP 或用户" />
                </label>
                <span class="server-tree-count">{{ showServerCount }} 台服务器</span>
            </div>

            <!-- 表头 + 扁平行列表：分组行与服务器行共用 grid，通过 row.type 分支 -->
            <div class="server-tree-card">
                <div class="server-tree-head" aria-hidden="true">
                    <span>名称</span>
                    <span>IP</span>
                    <span>端口</span>
                    <span>用户</span>
                    <span>创建时间</span>
                </div>
                <div class="server-tree-body" ref="serverTreeBodyRef">
                    <ServerTreeRow :row="serverRootGroup" :level="0" :selectedRawData="selectedRawData" :expandedGroupIds="expandedGroupIds" :copyData="copyData" :searchKeyword="keyword" />
                </div>
            </div>
        </section>
        <GlobalButton :bts="['setting', 'theme', 'themeMode']" :settingTab="'server'" />
    </div>
</template>

<style scoped lang="scss">
/*
 * 布局要点：
 * - 页面为纵向 flex，卡片 flex:1 + min-height:0 才能在固定高度父级内正确出现内部滚动条。
 * - 窄屏：表头隐藏；行布局见 ServerTreeRow.vue。
 */
.server-tree-page {
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 42px 46px 34px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: hidden;

    .server-tree-header,
    .server-tree-actions,
    .server-tree-toolbar,
    .server-tree-search {
        display: flex;
        align-items: center;
    }

    .server-tree-header {
        justify-content: space-between;
        gap: 16px;
    }

    .server-tree-title-block {
        min-width: 0;
    }

    .server-tree-kicker,
    .server-tree-title,
    .server-tree-empty-title {
        margin: 0;
    }

    .server-tree-kicker {
        font-size: var(--font-size-xs);
        letter-spacing: 0.16em;
        text-transform: uppercase;
    }

    .server-tree-title {
        margin-top: 4px;
        font-size: var(--font-size-icon);
        line-height: 1.15;
        font-weight: 700;
    }

    .server-tree-actions {
        gap: 8px;
        flex: 0 0 auto;
    }

    .server-tree-action {
        height: 30px;
        padding: 0 12px;
        border-radius: 8px;
        font: inherit;
        cursor: pointer;
    }

    .server-tree-toolbar {
        justify-content: space-between;
        gap: 12px;
    }

    .server-tree-search {
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

    .server-tree-search-icon {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
    }

    .server-tree-count {
        flex: 0 0 auto;
    }

    .server-tree-card {
        min-height: 0;
        flex: 1;
        border-radius: 14px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }

    .server-tree-head {
        width: 100%;
        display: grid;
        grid-template-columns: minmax(260px, 1.25fr) minmax(150px, 0.75fr) minmax(72px, 0.28fr) minmax(110px, 0.48fr) minmax(160px, 0.7fr);
        gap: 16px;
        align-items: center;
        min-height: 34px;
        padding: 0 16px;
        flex: 0 0 auto;
    }

    .server-tree-body {
        min-height: 0;
        flex: 1;
        overflow: auto;
        padding-bottom: 4px;
    }

    .server-tree-empty {
        flex: 1;
        min-height: 220px;
        border-radius: 14px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        text-align: center;
    }

    .server-tree-empty-icon {
        width: 34px;
        height: 34px;
        border-radius: 10px;
        padding: 7px;
    }

    .server-tree-empty-title {
        font-size: var(--font-size-xl);
        font-weight: 650;
    }

    @media (max-width: 760px) {
        padding: 38px 16px 22px;

        .server-tree-header,
        .server-tree-toolbar {
            align-items: stretch;
            flex-direction: column;
        }

        .server-tree-actions {
            .server-tree-action {
                flex: 1;
            }
        }

        .server-tree-head {
            display: none;
        }
    }
}
</style>
