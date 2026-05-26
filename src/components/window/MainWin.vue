<script setup lang="ts">
import { storeToRefs } from "pinia";
const channelInstancesStore = useChannelInstancesStore();

const { instances } = storeToRefs(channelInstancesStore);
</script>

<template>
    <DefaultLayout v-if="instances.length" />
    <ServerList v-else />
</template>

<style scoped lang="scss"></style>
