<script setup lang="ts">
const channelInstancesStore = useChannelInstancesStore();

const instances = computed(() => channelInstancesStore.instances);
const selectSessionId = computed(() => channelInstancesStore.selectSessionId);

onMounted(async () => {});
</script>

<template>
    <div class="w-full h-full relative">
        <div v-for="(server, i) in instances" :key="i" class="channel" :style="{ zIndex: server.zindex }" :class="{ active: selectSessionId === server.sessionId }">
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
