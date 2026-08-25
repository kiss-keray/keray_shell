<script setup lang="ts">
import { openOrFocusServerTreeWindow } from "@/utils/window";
import { storeToRefs } from "pinia";
import type { SettingsTab } from "./SettingDialog.vue";

defineOptions({
    name: "GlobalButton",
});
type Bts = "serverTree" | "setting" | "theme" | "themeMode" | "overviewPanel" | "termPanel" | "sftpPanel" | "agentPanel";

const props = withDefaults(
    defineProps<{
        bts?: Bts[];
        settingTab?: SettingsTab;
    }>(),
    {
        bts: () => ["serverTree", "setting", "theme", "themeMode", "overviewPanel", "termPanel", "sftpPanel", "agentPanel"],
        settingTab: () => "general",
    },
);

// 通过 Store 实例调用 action，确保 HMR 后始终读取最新函数。
const configStore = useConfigStore();
const appStore = useAppStore();
const { theme, themeMode } = storeToRefs(configStore);
const { showOverviewPanel, showTermPanel, showSftpPanel, showAgentPanel } = storeToRefs(appStore);

const isNtTheme = computed(() => theme.value === "nt");
const isDarkMode = computed(() => themeMode.value === "dark");

function clickSetting() {
    openOrFocusSettingsWindow(props.settingTab);
}

function openServerTreeWin() {
    openOrFocusServerTreeWindow();
}
</script>

<template>
    <div class="global-button flex items-center">
        <button v-if="bts.includes('serverTree')" type="button" class="btn" title="服务器列表" @click="openServerTreeWin">
            <Icon icon="material-symbols:folder" class="text-lg" />
        </button>
        <button v-if="bts.includes('agentPanel')" type="button" class="btn" :class="{ active: showAgentPanel }" title="Agent" @click="showAgentPanel = !showAgentPanel">
            <Icon :icon="showAgentPanel ? 'mdi:robot-outline' : 'mdi:robot-off-outline'" class="text-lg" />
        </button>
        <!-- macOS 下支持原生毛玻璃，其他系统不支持 -->
        <button
            v-if="bts.includes('theme') && appStore.osType === 'macos'"
            type="button"
            class="btn"
            :class="{ active: !isNtTheme }"
            title="切换主题（拟态/毛玻璃）"
            @click="configStore.changeConfig({ theme: isNtTheme ? 'glass' : 'nt' })"
        >
            <Icon :icon="isNtTheme ? 'mdi:water-outline' : 'mdi:water'" class="text-lg" />
        </button>
        <button v-if="bts.includes('themeMode')" type="button" class="btn" :class="{ active: !isDarkMode }" title="切换明暗模式" @click="configStore.changeConfig({ themeMode: isDarkMode ? 'light' : 'dark' })">
            <Icon :icon="isDarkMode ? 'mdi:weather-night' : 'mdi:white-balance-sunny'" class="text-lg" />
        </button>
        <button v-if="bts.includes('overviewPanel')" type="button" class="btn" :class="{ active: showOverviewPanel }" title="显示/隐藏概览面板" @click="showOverviewPanel = !showOverviewPanel">
            <Icon :icon="showOverviewPanel ? 'mdi:view-dashboard' : 'mdi:view-dashboard-outline'" class="text-lg" />
        </button>
        <button v-if="bts.includes('termPanel')" type="button" class="btn" :class="{ active: showTermPanel }" title="显示/隐藏终端面板" @click="showTermPanel = !showTermPanel">
            <Icon :icon="showTermPanel ? 'mdi:console' : 'mdi:console-line'" class="text-lg" />
        </button>
        <button v-if="bts.includes('sftpPanel')" type="button" class="btn" :class="{ active: showSftpPanel }" title="显示/隐藏SFTP面板" @click="showSftpPanel = !showSftpPanel">
            <Icon :icon="showSftpPanel ? 'mdi:folder-network' : 'mdi:folder-network-outline'" class="text-lg" />
        </button>
        <button v-if="bts.includes('setting')" type="button" class="btn" title="设置" @click="clickSetting">
            <Icon icon="mdi:cog" class="text-lg" />
        </button>
    </div>
</template>

<style scoped lang="scss">
.global-button {
    // 主窗口空间紧张，控制组压缩到标题栏内，避免向下侵占终端可视区域。
    gap: 10px;
    padding: 3px;
    border-radius: 11px;
    width: min-content;
    height: 30px;
    overflow: hidden;
}

.btn {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    opacity: 0.72;
    transition:
        color 0.16s ease,
        background-color 0.16s ease,
        box-shadow 0.16s ease,
        opacity 0.16s ease;

    &:hover {
        opacity: 1;
    }

    &.active {
        opacity: 1;
    }

    :deep(svg) {
        width: 18px;
        height: 18px;
    }
}
.windows {
    .global-button {
        left: 10px;
        right: unset;
    }
}
</style>
