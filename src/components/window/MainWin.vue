<script setup lang="ts">
import { storeToRefs } from "pinia";
const channelInstancesStore = useChannelInstancesStore();
const appStore = useAppStore();
const { isMainWin } = storeToRefs(appStore);

const { instances } = storeToRefs(channelInstancesStore);
</script>

<template>
    <DefaultLayout v-if="instances.length || !isMainWin" />
    <ServerList v-else />
</template>

<style scoped lang="scss"></style>
