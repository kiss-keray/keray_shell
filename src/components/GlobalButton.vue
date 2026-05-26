<script setup lang="ts">
import { openOrFocusServerTreeWindow } from "@/utils/window";
import { storeToRefs } from "pinia";
import type { SettingsTab } from "./SettingDialog.vue";

defineOptions({
    name: "GlobalButton",
});
type Bts = "serverTree" | "setting" | "theme" | "themeMode" | "overviewPanel" | "termPanel" | "sftpPanel";

const props = withDefaults(
    defineProps<{
        bts?: Bts[];
        settingTab?: SettingsTab;
    }>(),
    {
        bts: () => ["serverTree", "setting", "theme", "themeMode", "overviewPanel", "termPanel", "sftpPanel"],
        settingTab: () => "general",
    },
);

const configStore = useConfigStore();
const appStore = useAppStore();
const { theme, themeMode } = storeToRefs(configStore);
const { showOverviewPanel, showTermPanel, showSftpPanel } = storeToRefs(appStore);
const { changeConfig } = configStore;

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
    <div class="global-button flex items-center gap-1">
        <button v-if="bts.includes('serverTree')" type="button" class="btn" title="服务器列表" @click="openServerTreeWin">
            <Icon icon="material-symbols:folder" class="text-lg" />
        </button>
        <!-- macOS 下支持原生毛玻璃，其他系统不支持 -->
        <button
            v-if="bts.includes('theme') && appStore.osType === 'macos'"
            type="button"
            class="btn"
            :class="{ active: !isNtTheme }"
            title="切换主题（拟态/毛玻璃）"
            @click="changeConfig({ theme: isNtTheme ? 'glass' : 'nt' })"
        >
            <Icon :icon="isNtTheme ? 'mdi:water-outline' : 'mdi:water'" class="text-lg" />
        </button>
        <button v-if="bts.includes('themeMode')" type="button" class="btn" :class="{ active: !isDarkMode }" title="切换明暗模式" @click="changeConfig({ themeMode: isDarkMode ? 'light' : 'dark' })">
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
    padding: 0 10px;
    border-radius: 8px;
    width: min-content;
    height: 18px;
}

.btn {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    opacity: 0.78;

    &:hover {
        opacity: 1;
        transform: translateY(-1px);
    }

    &.active {
        opacity: 1;
    }
}
</style>
