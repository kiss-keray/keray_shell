<script setup lang="ts">
import { SftpActiveItemKey } from "@/utils/constant";
import type { FileStoreItem } from ".";
import useBus, { DirectRemotePathEventKey, DownloadMenuOpenEventKey, RefreshFileListEventKey } from "@/composables/useBus";
import { removeArrayItem } from "@/utils";
const server = inject<ChannelInstance>(ChannelInstanceProvideKey)!;

const historyOpen = ref(false);
const pathHistory = ref<string[]>([]);
const activeItem = inject<Ref<FileStoreItem>>(SftpActiveItemKey)!;
const pathDraft = ref(activeItem.value.id);

const { emit } = useBus();

watch(activeItem, (newVal) => {
    pathDraft.value = newVal.id;
    removeArrayItem(pathHistory.value, pathDraft.value);
    pathHistory.value.unshift(pathDraft.value);
});

function applyPath() {
    emit(DirectRemotePathEventKey, { sid: server.sessionId, path: pathDraft.value });
}

function onSelectHistory(path: string) {
    emit(DirectRemotePathEventKey, { sid: server.sessionId, path: path });
    historyOpen.value = false;
}
</script>

<template>
    <div class="toolbar shrink-0 flex items-center gap-2 px-2 py-2">
        <input v-model="pathDraft" class="path-input grow min-w-0 rounded px-2 py-1 text-sm outline-none" placeholder="路径" @keydown.enter.prevent="applyPath" />
        <div class="actions flex items-center gap-1 shrink-0">
            <div class="relative">
                <button type="button" class="tb-btn" @click="historyOpen = !historyOpen">历史</button>
                <div v-if="historyOpen" class="hist-pop absolute right-0 top-full z-20 mt-1 max-h-48 min-w-[200px] overflow-auto rounded py-1 text-sm">
                    <button v-for="h in pathHistory" :key="h" type="button" class="hist-item block w-full px-3 py-1.5 text-left" @click="onSelectHistory(h)">
                        {{ h }}
                    </button>
                    <p v-if="!pathHistory.length" class="hist-empty px-3 py-2">暂无记录</p>
                </div>
            </div>
            <button type="button" class="icon-btn" title="刷新" @click="emit(RefreshFileListEventKey)">
                <Icon icon="mdi:refresh" class="text-lg" />
            </button>
            <div class="relative">
                <button type="button" class="icon-btn" title="上传">
                    <Icon icon="mdi:upload" class="text-lg" />
                </button>
            </div>
            <button type="button" class="icon-btn" title="下载" @click="emit(DownloadMenuOpenEventKey)">
                <Icon icon="mdi:download" class="text-lg" />
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
.path-input {
    color: inherit;
}

.tb-btn {
    padding: 4px 10px;
    border-radius: 4px;
}

.icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 4px;
}
</style>
