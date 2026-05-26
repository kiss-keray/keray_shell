<script setup lang="ts">
import { storeToRefs } from "pinia";
import type { FileStoreItem } from ".";
import type { UnlistenFn } from "@tauri-apps/api/event";

const props = defineProps<{
    rootFile: FileStoreItem;
}>();
type TermSnapshot = {
    treePanelScrollTop: number;
};

const server = inject<ChannelInstance>(ChannelInstanceProvideKey)!;

const treeRootRef = ref<HTMLDivElement>();

const closeFuns: UnlistenFn[] = [];

onMounted(() => {
    server.snapshotFn.sftpTree = () => {
        return {
            treePanelScrollTop: treeRootRef.value?.scrollTop,
        } as TermSnapshot;
    };
    nextTick(() => {
        if (server.snapshot.sftpTree) {
            const snapshot = server.snapshot.sftpTree as TermSnapshot;
            delete server.snapshot.sftpTree;
            treeRootRef.value!.scrollTop = snapshot.treePanelScrollTop;
        }
    });
});
onUnmounted(() => {
    closeFuns.forEach((unlisten) => unlisten());
});
dragListener(() => {
    return Array.from(treeRootRef.value?.querySelectorAll(".tree-row") ?? []);
}).then((unlisten) => {
    closeFuns.push(unlisten);
});
</script>

<template>
    <div class="tree-root" ref="treeRootRef">
        <SftpDirTreeItem v-if="treeRootRef" :file-item="rootFile" :tree-root-ref="treeRootRef" />
    </div>
</template>

<style scoped lang="scss">
.tree-root {
    overflow-y: auto;
}
</style>
