<script setup lang="ts">
import type { ChannelInstance, ChannelInstanceGroup } from "@/stores/channelInstances";
import type { Tag } from "./ServerOverviewPanel.vue";

const props = defineProps<{
    group: ChannelInstanceGroup;
}>();

const channelInstancesStore = useChannelInstancesStore();

const tags = ref<Tag[]>(["system", "net"]);
const itemWidth = ref(300);
const diskHeight = ref(150);
const diskFilter = ref("");
const tagsInput = ref<Tag[]>([...tags.value]);
const itemWidthInput = ref(itemWidth.value);
const diskHeightInput = ref(diskHeight.value);
const diskFilterInput = ref(diskFilter.value);

function closeInstance(item: ChannelInstance) {
    props.group.instances.remove(item);
    if (props.group.instances.length === 0) {
        channelInstancesStore.del(props.group);
        return;
    }
}

function toggleTag(tag: Tag) {
    if (tagsInput.value.includes(tag)) {
        tagsInput.value = tagsInput.value.filter((t) => t !== tag);
    } else {
        tagsInput.value.push(tag);
    }
}

function reset() {
    tagsInput.value = [...tags.value];
    itemWidthInput.value = itemWidth.value;
    diskHeightInput.value = diskHeight.value;
    diskFilterInput.value = diskFilter.value;
}

function apply() {
    tags.value = [...tagsInput.value];
    itemWidth.value = itemWidthInput.value;
    diskHeight.value = diskHeightInput.value;
    diskFilter.value = diskFilterInput.value;
}
</script>

<template>
    <div ref="container" class="monitor-group">
        <div class="tags" aria-label="监控面板配置">
            <div class="tag-switches">
                <label class="tag-item tag-check" :class="{ active: tagsInput.includes('system') }">
                    <input type="checkbox" :checked="tagsInput.includes('system')" @change="toggleTag('system')" />
                    <span>系统</span>
                </label>
                <label class="tag-item tag-check" :class="{ active: tagsInput.includes('process') }">
                    <input type="checkbox" :checked="tagsInput.includes('process')" @change="toggleTag('process')" />
                    <span>进程</span>
                </label>
                <label class="tag-item tag-check" :class="{ active: tagsInput.includes('net') }">
                    <input type="checkbox" :checked="tagsInput.includes('net')" @change="toggleTag('net')" />
                    <span>网络</span>
                </label>
                <label class="tag-item tag-check" :class="{ active: tagsInput.includes('disk') }">
                    <input type="checkbox" :checked="tagsInput.includes('disk')" @change="toggleTag('disk')" />
                    <span>磁盘</span>
                </label>
            </div>
            <div class="tag-fields">
                <label class="tag-item tag-field">
                    <span>监控宽度</span>
                    <input v-model.number="itemWidthInput" type="number" min="160" step="10" />
                </label>
                <label class="tag-item tag-field">
                    <span>磁盘高度</span>
                    <input v-model.number="diskHeightInput" type="number" min="80" step="10" />
                </label>
                <label class="tag-item tag-field tag-field-filter">
                    <span>磁盘过滤</span>
                    <input v-model="diskFilterInput" type="text" />
                </label>
            </div>
            <div class="tag-actions">
                <button type="button" class="tag-btn" @click="reset">重置</button>
                <button type="button" class="tag-btn tag-btn-primary" @click="apply">应用</button>
            </div>
        </div>
        <div class="instances">
            <div v-for="instance in group.instances" :key="instance.sessionId" class="child-box">
                <div class="server-title">
                    <p>{{ instance.server.name }}</p>
                    <Icon icon="si:close-duotone" class="pointer icon close-icon" @click.stop="closeInstance(instance)" />
                </div>
                <ServerOverviewPanel :instance="instance" :tags="tags" :only-mount="true" :disk-height="diskHeight" :disk-filter="diskFilter" :style="{ width: itemWidth + 'px' }" />
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.monitor-group {
    width: 100vw;
    height: 100%;
    position: relative;
    box-sizing: border-box;
    padding: 10px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    .instances {
        flex: 1;
        display: flex;
        flex-direction: row;
        flex-wrap: wrap;
        overflow: auto;
        .child-box {
            position: relative;
            padding: 5px;
            margin: 5px;
            height: min-content;
            border-radius: 8px;
        }
    }
    .tags {
        /* 监控项较多时保持配置栏可见，便于横向批量调整面板。 */
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        position: sticky;
        top: 0;
        z-index: 2;
        margin-bottom: 10px;
        padding: 8px;
        border-radius: 8px;
    }
    .tag-switches,
    .tag-fields,
    .tag-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }
    .tag-item {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        border-radius: 6px;
        font-size: var(--font-size-xs);
        line-height: 1;
        white-space: nowrap;
    }
    .tag-check {
        gap: 6px;
        padding: 0 10px;
        cursor: pointer;
        user-select: none;
    }
    .tag-check input {
        width: 13px;
        height: 13px;
        margin: 0;
        accent-color: currentColor;
    }
    .tag-field {
        gap: 8px;
        padding: 0 8px;
    }
    .tag-field input {
        width: 76px;
        height: 26px;
        box-sizing: border-box;
        border: none;
        border-radius: 6px;
        padding: 0 8px;
        font: inherit;
        outline: none;
    }
    .tag-field-filter input {
        width: 140px;
    }
    .tag-btn {
        min-width: 52px;
        height: 30px;
        border: none;
        border-radius: 6px;
        padding: 0 12px;
        font: inherit;
        cursor: pointer;
    }
}

.server-title {
    width: 100%;
    height: 20px;
    display: flex;
    justify-content: center;
    align-items: center;
    .close-icon {
        position: absolute;
        right: 5px;
        font-size: var(--font-size-xl);
    }
}

@media (max-width: 720px) {
    .monitor-group {
        .tags {
            align-items: stretch;
        }
        .tag-switches,
        .tag-fields,
        .tag-actions {
            width: 100%;
        }
        .tag-field-filter,
        .tag-field-filter input {
            flex: 1;
        }
    }
}
</style>
