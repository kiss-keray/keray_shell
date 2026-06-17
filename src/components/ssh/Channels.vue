<script setup lang="ts">
defineOptions({
    name: "TermChannels",
});
const channelInstancesStore = useChannelInstancesStore();
const { instances, selectSessionId } = toRefs(channelInstancesStore);

onMounted(async () => {
    console.log("instances", instances.value);
});
</script>

<template>
    <div class="w-full h-full relative">
        <div v-for="server in instances" :key="server.sessionId" class="channel" :style="{ zIndex: server.zindex }" :class="{ active: selectSessionId === server.sessionId }">
            <slot :server="server" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.channel {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    opacity: 0;

    &.active {
        pointer-events: auto;
        opacity: 1;
    }
}
</style>
