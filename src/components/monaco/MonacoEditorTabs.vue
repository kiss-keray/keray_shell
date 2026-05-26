<script setup lang="ts">
/** 编辑器 Tab 项（由 MonacoWin 传入） */
export type MonacoTabItem = {
    key: string;
    title: string;
    dirty: boolean;
    loading: boolean;
    saving: boolean;
};

defineOptions({
    name: "MonacoEditorTabs",
});

const props = defineProps<{
    tabs: MonacoTabItem[];
    activeKey: string;
}>();

const emit = defineEmits<{
    select: [key: string];
    close: [key: string];
}>();

function onSelect(key: string) {
    if (key !== props.activeKey) emit("select", key);
}

function onClose(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    emit("close", key);
}

/** 中键关闭（编辑器常见交互） */
function onAuxClick(e: MouseEvent, key: string) {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    emit("close", key);
}
</script>

<template>
    <div class="monaco-tabs">
        <div class="monaco-tabs-scroll">
            <!-- 外层用 div，避免 button 嵌套导致关闭按钮失效 -->
            <div
                v-for="tab in tabs"
                :key="tab.key"
                role="tab"
                tabindex="0"
                class="monaco-tab"
                :class="{ active: tab.key === activeKey, dirty: tab.dirty, loading: tab.loading, saving: tab.saving }"
                :aria-selected="tab.key === activeKey"
                @click="onSelect(tab.key)"
                @auxclick="onAuxClick($event, tab.key)"
                @keydown.enter="onSelect(tab.key)"
            >
                <span class="monaco-tab-title">{{ tab.title }}</span>
                <span v-if="tab.loading" class="monaco-tab-badge">↓</span>
                <span v-else-if="tab.saving" class="monaco-tab-badge">↑</span>
                <span v-else-if="tab.dirty" class="monaco-tab-dot" aria-hidden="true">•</span>
                <button type="button" class="monaco-tab-close" aria-label="关闭" @click="onClose($event, tab.key)">×</button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.monaco-tabs {
    flex-shrink: 0;
    min-height: 34px;
    overflow: hidden;

    .monaco-tabs-scroll {
        display: flex;
        align-items: stretch;
        gap: 4px;
        height: 100%;
        padding: 4px 6px 0;
        overflow-x: auto;
        overflow-y: hidden;
    }

    .monaco-tab {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 220px;
        padding: 0 8px;
        border: 0;
        border-radius: 6px 6px 0 0;
        background: transparent;
        cursor: pointer;
        flex-shrink: 0;
        outline: none;
        user-select: none;

        .monaco-tab-title {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            line-height: 28px;
        }

        .monaco-tab-dot {
            flex-shrink: 0;
            font-size: var(--font-size-lg);
            line-height: 1;
        }

        .monaco-tab-badge {
            flex-shrink: 0;
            font-size: var(--font-size-2xs);
            line-height: 1;
        }

        .monaco-tab-close {
            flex-shrink: 0;
            width: 18px;
            height: 18px;
            padding: 0;
            border: 0;
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            font-size: var(--font-size-lg);
            line-height: 1;
            opacity: 0.72;

            &:hover {
                opacity: 1;
            }
        }
    }
}
</style>
