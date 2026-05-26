<script setup lang="ts">
import type { SettingsTab } from "@/components/SettingDialog.vue";

const activeTab = ref<SettingsTab>("general");
onMounted(() => {
    document.body.classList.add("setting-window");
    const params = new URLSearchParams(location.search);
    activeTab.value = (params.get("tab") as SettingsTab) || "general";
});
</script>

<template>
    <SettingDialog v-model:activeTab="activeTab" />
</template>
