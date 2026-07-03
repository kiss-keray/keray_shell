<script setup lang="ts">
import { isChannelInstance } from "@/stores/channelInstances";
import { storeToRefs } from "pinia";

const configStore = useConfigStore();
const appStore = useAppStore();
const channelInstancesStore = useChannelInstancesStore();
const { selectSession } = toRefs(channelInstancesStore);

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
        <template v-if="selectSession && isChannelInstance(selectSession)">
            <div v-show="showOverviewPanel" :style="{ width: `${overviewWidthPx}px` }">
                <ServerOverviewPanel :instance="selectSession" :key="selectSession.sessionId" />
            </div>
            <LayoutColumnResizer v-show="showOverviewPanel" v-model="overviewWidthPx" :min="OVERVIEW_MIN" :max="OVERVIEW_MAX" />
        </template>
        <div class="flex flex-col grow min-w-0 right-box">
            <ShellInstance />
            <Channels>
                <template #default="{ server }">
                    <Term v-if="isChannelInstance(server)" :server="server" />
                    <TermGroup v-else-if="server.type === 'terminal'" :group="server" />
                    <MonitorGroup v-else-if="server.type === 'monitor'" :group="server" />
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
        // 七个 16px 快捷按钮及间距约占 124px，为服务器 Tab 留出不重叠区域。
        padding-right: 132px;
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
