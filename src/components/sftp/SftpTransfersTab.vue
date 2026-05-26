<script setup lang="ts">
import { CONCURRENCY_MAX, CONCURRENCY_MIN, useDownloadStore } from "@/stores/downloadStore";
import { storeToRefs } from "pinia";

defineOptions({ name: "SftpTransfersTab" });

const { concurrency, allLoadingFlag, canPauseAll, canResumeAll, canCancelAll, totalCount, taskItems } = storeToRefs(useDownloadStore());
const { stopAllTasks, startAllTasks, cancelAllTasks, cleanFinishedTasks } = useDownloadStore();
</script>

<template>
    <div class="transfers-panel flex grow min-h-[120px] flex-col">
        <div class="transfers-head flex shrink-0 items-center gap-3 px-3 pt-2 pb-2 text-xs">
            <span class="shrink-0">传输记录（上传/下载）</span>
            <div class="concurrency flex items-center gap-2 shrink-0">
                <span class="concurrency-label">并行</span>
                <input v-model.number="concurrency" type="range" class="concurrency-slider" :min="CONCURRENCY_MIN" :max="CONCURRENCY_MAX" step="1" :title="`并行 ${concurrency}`" />
                <span class="tabular-nums w-5 text-right">{{ concurrency }}</span>
            </div>
            <div class="bulk-actions flex flex-wrap items-center gap-1 shrink-0">
                <button type="button" class="tx-btn" :class="{ 'tx-btn--inline-loading': allLoadingFlag === 'stop' }" :disabled="!canPauseAll || allLoadingFlag !== 'none'" @click="stopAllTasks">
                    <Icon v-if="allLoadingFlag === 'stop'" icon="mdi:loading" class="tx-btn-load-ic" />
                    全部暂停
                </button>
                <button type="button" class="tx-btn" :disabled="!canResumeAll || allLoadingFlag !== 'none'" @click="startAllTasks">全部开始</button>
                <button type="button" class="tx-btn tx-btn--danger" :disabled="!canCancelAll || allLoadingFlag !== 'none'" @click="cancelAllTasks">全部取消</button>
            </div>
            <span class="grow" />
            <button type="button" class="clean-btn rounded px-2 py-1 shrink-0" @click="cleanFinishedTasks">清理已完成</button>
        </div>
        <div v-if="totalCount === 0" class="empty-tip px-3 pb-3 text-xs">暂无传输任务</div>
        <div v-else class="transfers-list flex flex-col gap-2 overflow-auto px-3 pb-3 pr-2">
            <SftpTransferItem v-for="item in taskItems" :key="item.id" :item="item" :level="0" />
        </div>
    </div>
</template>

<style scoped lang="scss">
.transfers-panel {
    padding-right: 20px;
}

.concurrency-slider {
    width: 120px;
}

.tx-btn--inline-loading {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.tx-btn-load-ic {
    flex-shrink: 0;
    opacity: 0.9;
    animation: sftp-tx-spin 0.85s linear infinite;
}
@keyframes sftp-tx-spin {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}
.tx-btn {
    font-size: var(--font-size-2xs);
    line-height: 1.2;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
}
.tx-btn:disabled {
    opacity: 0.42;
    cursor: not-allowed;
    pointer-events: none;
}
</style>
