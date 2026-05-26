<script setup lang="ts">
import { baseName } from "@/utils/fsUtil";
import type { TransferUiItem } from ".";
import { formatAdaptiveBytes, formatSpeedBps } from "@/utils/project";
import { countdownText } from "@/utils";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { MenuItem } from "../DefaultMenuItems.vue";

const props = defineProps<{
    item: TransferUiItem;
    level: number;
}>();

const open = ref(true);

const canPause = computed(() => props.item.status === "running" || props.item.status === "queued");
const canResume = computed(() => props.item.status === "paused");
const canCancel = computed(() => ["running", "queued", "paused", "error"].includes(props.item.status));
const canRetry = computed(() => props.item.status === "error");

function statusText(status: TransferStatus): string {
    if (status === "running") return "进行中";
    if (status === "queued") return "排队";
    if (status === "paused") return "已暂停";
    if (status === "cancelled") return "已取消";
    if (status === "success") return "完成";
    return "失败";
}

async function handleOpenFile() {
    const localPath = props.item.localPath;
    if (!localPath || props.item.isDir) return;
    try {
        await openPath(localPath);
    } catch (e) {
        console.error(e);
        showToast(e instanceof Error ? e.message : "打开文件失败", "error");
    }
}

async function handleRevealInDir() {
    const localPath = props.item.localPath;
    if (!localPath) return;
    try {
        await revealItemInDir(localPath);
    } catch (e) {
        showToast(e instanceof Error ? e.message : "打开所在位置失败", "error");
    }
}

function openContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const isFile = !props.item.isDir;
    const menus: MenuItem[] = [
        {
            label: "打开",
            disabled: !isFile,
            handler: () => void handleOpenFile(),
        },
        {
            label: "打开所在位置",
            handler: () => void handleRevealInDir(),
        },
        "---",
        {
            label: "取消并删除本地",
            handler: async () => {
                props.item.cancel();
                removeLocalIfAny(props.item.localPath);
            },
        },
    ];
    document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: e } }));
}
</script>

<template>
    <div v-if="item.status !== 'cancelled'" :style="{ marginLeft: `${level * 24}px` }" class="transfer-item" @contextmenu="openContextMenu($event)">
        <div class="w-full">
            <div class="line1" :class="{ [item.isDir ? 'is-dir' : 'is-file']: true }">
                <div class="flex items-center gap-2">
                    <Icon v-if="item.isDir" :icon="open ? 'mdi:chevron-down' : 'mdi:chevron-right'" class="group-ic" @click.stop="open = !open" />
                    <Icon :icon="item.kind === 'download' ? 'mdi:download' : 'mdi:upload'" class="group-ic" />
                    <span class="item-name truncate">{{ item.name }}</span>
                </div>
                <div class="item-actions" @click.stop>
                    <button v-if="canPause" type="button" class="tx-btn" :class="{ 'tx-btn--inline-loading': item.loadingFlag === 'stop' }" :disabled="item.loadingFlag !== 'none'" @click="item.stop">
                        <Icon v-if="item.loadingFlag === 'stop'" icon="mdi:loading" class="tx-btn-load-ic" />
                        暂停
                    </button>
                    <button v-if="canResume" type="button" class="tx-btn" :disabled="item.loadingFlag !== 'none'" @click="item.resume">继续</button>
                    <button v-if="canCancel" type="button" class="tx-btn tx-btn--danger" :disabled="item.loadingFlag !== 'none'" @click="item.cancel">取消</button>
                    <button v-if="canRetry" type="button" class="tx-btn tx-btn--accent" @click="item.retry">重试</button>
                </div>
            </div>
            <div class="line2 progress">
                <div class="download-track"><div class="download-bar" :key="item.loaded" :style="{ width: `${((item.loaded / (item.total || 1)) * 100).toFixed(2)}%` }" /></div>
                <p class="bfb">{{ ((item.loaded / (item.total || 1)) * 100).toFixed(2) }}%</p>
                <span v-if="item.isDir" class="item-name size-name">{{ item.loaded }}/{{ item.total }}</span>
                <span v-else class="item-name size-name">{{ formatAdaptiveBytes(item.loaded) }}/{{ formatAdaptiveBytes(item.total) }}</span>
                <div v-if="item.status === 'running'" class="bps">{{ formatSpeedBps(item.speedBps) }}</div>
                <div v-else class="bps">0B/s</div>
                <div v-if="item.status === 'running'" class="remaining-time">{{ countdownText(item.remainingTime ?? 0) }}</div>
                <div v-else class="remaining-time">{{ countdownText(item.remainingTime ?? 0) }}</div>
                <span class="item-state" :class="item.status">{{ item.error }} {{ statusText(item.status) }}</span>
            </div>
        </div>
        <Transition name="children-collapse">
            <div v-if="open" class="children">
                <SftpTransferItem v-for="child in item.children" :key="child.id" :item="child" :level="level + 1" />
            </div>
        </Transition>
    </div>
</template>

<style scoped lang="scss">
.transfer-item {
    margin: 8px 0;
    .line1 {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .line2 {
        margin-top: 8px;
    }
}

.progress {
    display: flex;
    align-items: center;
    .download-track {
        height: 4px;
        border-radius: 999px;
        flex-grow: 1;
        overflow: hidden;
    }

    .bfb {
        text-align: center;
        width: 6em;
    }
    .size-name {
        width: 12em;
    }
    .bps {
        width: 8em;
    }
    .item-state {
        width: 6rem;
        text-align: right;
        flex-shrink: 0;
    }
}

.group-ic {
    font-size: var(--font-size-2xl);
    flex-shrink: 0;
}
.download-bar {
    height: 100%;
    transition: width 0.2s ease;
}
.item-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    max-width: 100%;
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
.tx-btn--danger {
}
.tx-btn--accent {
}

.children-collapse-enter-active,
.children-collapse-leave-active {
    transition:
        max-height 0.25s ease,
        opacity 0.22s ease,
        margin-top 0.25s ease;
    overflow: hidden;
}
.children-collapse-enter-from,
.children-collapse-leave-to {
    max-height: 0;
    opacity: 0;
    margin-top: 0;
}
.children-collapse-enter-to,
.children-collapse-leave-from {
    max-height: 1200px;
    opacity: 1;
    margin-top: 4px;
}
</style>
