<script setup lang="ts">
import { storeToRefs } from "pinia";

const configStore = useConfigStore();
const appStore = useAppStore();

const { appType } = appStore;
const { showOverviewPanel } = storeToRefs(appStore);
const { overviewWidthPx } = storeToRefs(configStore);

const OVERVIEW_MIN = 200;
const OVERVIEW_MAX = 480;

onMounted(async () => {
    document.documentElement.classList.add("default");
});
</script>

<template>
    <div ref="viwer" class="w-full h-full relative flex flex-row default-layout">
        <div v-show="showOverviewPanel" :style="{ width: `${overviewWidthPx}px` }">
            <ServerOverviewPanel />
        </div>
        <LayoutColumnResizer v-show="showOverviewPanel" v-model="overviewWidthPx" :min="OVERVIEW_MIN" :max="OVERVIEW_MAX" />
        <div class="flex flex-col grow min-w-0 right-box">
            <ShellInstance />
            <Channels>
                <template #default="{ server }">
                    <Term :server="server" />
                </template>
            </Channels>
        </div>
        <GlobalButton />
    </div>
</template>
<style lang="scss">
.default-layout {
    .right-box {
        padding-right: 2px;
    }
    > div {
        z-index: 1;
    }
    overflow: hidden;
    .servers {
        padding-right: 203px;
    }
    .panel-empty {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--font-size-md);
        opacity: 0.55;
    }
}
</style>
