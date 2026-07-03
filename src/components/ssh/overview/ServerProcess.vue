<script setup lang="ts">
const props = defineProps<{
    instance: ChannelInstance;
    onlyMount?: boolean;
}>();

const overview = computed<ServerOverviewState | undefined>(() => props.instance?.overview);
const processes = computed(() => overview.value?.processes ?? []);
const procSort = computed<OverviewProcessSort>(() => (overview.value?.processSort === "cpu" ? "cpu" : "mem"));

function setProcSort(v: OverviewProcessSort) {
    const o = props.instance?.overview;
    if (o) o.processSort = v === "cpu" ? "cpu" : "mem";
}
</script>

<template>
    <div class="module resource">
        <div class="proc-toolbar">
            <span class="proc-toolbar-label">进程 TOP5</span>
            <span class="proc-toolbar-hint">点击「内存 / CPU」表头按该项降序</span>
        </div>
        <table class="tbl proc">
            <colgroup>
                <col class="col-mem" />
                <col class="col-cpu" />
                <col class="col-cmd" />
            </colgroup>
            <thead>
                <tr>
                    <th scope="col" class="proc-th-sort" :class="{ 'proc-th-sort--active': procSort === 'mem' }" :aria-sort="procSort === 'mem' ? 'descending' : 'none'">
                        <button type="button" class="proc-sort-btn" @click="setProcSort('mem')">
                            <span class="proc-sort-label">内存</span>
                            <span v-if="procSort === 'mem'" class="proc-sort-mark" title="当前按内存降序">↓</span>
                        </button>
                    </th>
                    <th scope="col" class="proc-th-sort" :class="{ 'proc-th-sort--active': procSort === 'cpu' }" :aria-sort="procSort === 'cpu' ? 'descending' : 'none'">
                        <button type="button" class="proc-sort-btn" @click="setProcSort('cpu')">
                            <span class="proc-sort-label">CPU</span>
                            <span v-if="procSort === 'cpu'" class="proc-sort-mark" title="当前按 CPU 降序">↓</span>
                        </button>
                    </th>
                    <th scope="col" class="proc-th-plain">命令</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="(p, i) in processes" :key="i" :class="{ alt: i % 2 === 1 }">
                    <td>{{ p.mem }}</td>
                    <td>{{ p.cpu }}</td>
                    <td class="cmd">{{ p.cmd }}</td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style scoped lang="scss">
.resource {
    padding: 10px 12px;
    line-height: 1.35;
    border-radius: 8px;
}

.proc-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}

.proc-toolbar-label {
    font-size: var(--font-size-xs);
    font-weight: 600;
    opacity: 0.9;
}

.proc-toolbar-hint {
    margin-left: auto;
    font-size: var(--font-size-2xs);
    opacity: 0.65;
}

.proc-th-sort {
    padding: 0;
    vertical-align: bottom;
}

.proc-th-sort--active .proc-sort-label {
    font-weight: 700;
}

.proc-sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    width: 100%;
    margin: 0;
    padding: 5px 6px;
    border: none;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    line-height: 1.2;
}

.proc-sort-mark {
    font-size: var(--font-size-2xs);
    opacity: 0.95;
    font-weight: 700;
}

.proc-th-plain {
    font-weight: 600;
    padding: 5px 6px;
    text-align: left;
    font-size: var(--font-size-xs);
}

.tbl {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 10px;
    table-layout: fixed;
}

.tbl.proc col.col-mem {
    width: 6em;
}

.tbl.proc col.col-cpu {
    width: 5em;
}

.tbl.proc col.col-cmd {
    width: auto;
}

.tbl.proc th:not(.proc-th-sort):not(.proc-th-plain) {
    font-weight: 600;
    padding: 5px 6px;
    text-align: left;
    font-size: var(--font-size-xs);
}

.tbl.proc th:nth-child(1),
.tbl.proc th:nth-child(2),
.tbl.proc td:nth-child(1),
.tbl.proc td:nth-child(2) {
    white-space: nowrap;
    padding-left: 4px;
    padding-right: 4px;
}

.tbl.proc td {
    padding: 4px 6px;
    font-size: var(--font-size-xs);
}

.tbl.proc .cmd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
