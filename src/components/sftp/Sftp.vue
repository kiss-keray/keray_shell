<script setup lang="ts">
import { useDownloadStore } from "@/stores/downloadStore";
import SftpDirTree from "./SftpDirTree.vue";
import SftpFileTable from "./SftpFileTable.vue";
import SftpTransfersTab from "./SftpTransfersTab.vue";
import SftpToolbar from "./SftpToolbar.vue";
import type { FileStoreItem } from ".";
import { SftpActiveItemKey } from "@/utils/constant";
import { storeToRefs } from "pinia";
import useBus, { SftpProcessEventKey } from "@/composables/useBus";

const TREE_WIDTH_MIN = 120;
const TREE_WIDTH_MAX = 520;

defineOptions({ name: "RemoteSftpPane" });

type SftpSnapshot = {
    rootFile: FileStoreItem;
    activeItemId: string;
};

const props = defineProps<{
    writeTerminal: (s: string) => void;
}>();

const { on, off } = useBus();

const { activeCount } = storeToRefs(useDownloadStore());
const { sftpTreeWidthPx } = storeToRefs(useConfigStore());

const server = inject<ChannelInstance>(ChannelInstanceProvideKey)!;

const activeTab = ref<"files" | "downloads">("files");
/** 所有已加载目录的完整子项（目录+文件）；DirTree 自行 filter is_dir */
const rootFile = ref<FileStoreItem>({
    id: "/", // 文件绝对路径
    parentId: "", // 父级绝对路径
    level: 0,
    children: null,
    parent: null,
    leaf: true,

    size: null, // 文件大小
    isDir: true, // 是否是目录
    linkPath: null, // 如果是符号链接，则为目标路径
    updatedAt: null, // 更新时间
    permissions: 0, // 权限
    owner: "", // 所有者
    group: "", // 所属组
    toJSON: function () {
        return {
            ...this,
            parent: null,
        };
    },
});
const activeItem = ref<FileStoreItem>(rootFile.value);
const process = ref<number>(0);

function handleSftpProcess(event: number) {
    process.value = event;
}

onBeforeMount(() => {
    server.snapshotFn.sftpData = () => {
        return {
            rootFile: rootFile.value,
            activeItemId: activeItem.value.id,
        } as SftpSnapshot;
    };
    if (server.snapshot.sftpData) {
        const snapshot = server.snapshot.sftpData as SftpSnapshot;
        // 快照用了就要删除
        delete server.snapshot.sftpData;
        rootFile.value = snapshot.rootFile;
        treeForEach<FileStoreItem>(rootFile.value, (item: FileStoreItem, parent?: FileStoreItem) => {
            item.toJSON = function () {
                return {
                    ...this,
                    parent: null,
                };
            };
            if (parent) {
                item.parent = parent;
            }
            if (item.id === snapshot.activeItemId) {
                activeItem.value = item;
            }
        });
    }
});

onUnmounted(() => {
    off(SftpProcessEventKey, handleSftpProcess);
});

on(SftpProcessEventKey, handleSftpProcess);

provide(SftpActiveItemKey, activeItem);
</script>

<template>
    <div class="sftp-panel relative flex flex-col h-full">
        <div class="tabs shrink-0 flex items-center gap-1">
            <button type="button" class="tab" :class="{ on: activeTab === 'files' }" @click="activeTab = 'files'">文件</button>
            <button type="button" class="tab" :class="{ on: activeTab === 'downloads' }" @click="activeTab = 'downloads'">
                传输
                <span class="tab-badge">{{ activeCount }}</span>
            </button>
            <div class="sftp-process">
                <div v-show="process && process < 100" class="process-container">
                    <div class="process-bar" :style="{ width: `${process}%` }"></div>
                </div>
            </div>
        </div>

        <div v-show="activeTab === 'files'" class="files-view flex grow min-h-0 flex-col">
            <SftpToolbar />
            <div class="main flex grow min-h-0 overflow-hidden">
                <SftpDirTree :style="{ width: `${sftpTreeWidthPx}px` }" :root-file="rootFile" />
                <LayoutColumnResizer v-model="sftpTreeWidthPx" :min="TREE_WIDTH_MIN" :max="TREE_WIDTH_MAX" />
                <SftpFileTable :root-file="rootFile" />
            </div>
        </div>
        <SftpTransfersTab v-show="activeTab === 'downloads'" />
    </div>
</template>

<style scoped lang="scss">
.sftp-panel {
    overflow: hidden;
    .tabs {
        padding: 2px 4px;
        width: min-content;
        border-radius: 8px;
        overflow: hidden;
        .tab {
            padding: 4px 10px;
            font-size: var(--font-size-md);
            white-space: nowrap;
            &.on {
                border-radius: 6px;
            }
        }
    }
}

.tab-badge {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: var(--font-size-xs);
}
.sftp-process {
    display: flex;
    flex-grow: 1;
    justify-content: flex-end;
    .process-container {
        width: 100px;
        height: 10px;
        text-align: -webkit-right;
        overflow: hidden;
        border-radius: 2px;
        .process-bar {
            height: 100%;
            border-radius: 2px 0 0 2px;
        }
    }
}
</style>
