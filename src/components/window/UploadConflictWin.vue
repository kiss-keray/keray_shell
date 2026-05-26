<script setup lang="ts">
import { emit, TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storeToRefs } from "pinia";
import { UPLOAD_CONFLICT_DATA_EVENT, UPLOAD_CONFLICT_RESOLVED_EVENT, type UploadConflictAction, type UploadConflictWindowPayload } from "@/utils/window";

defineOptions({
    name: "UploadConflictWin",
});

const appStore = useAppStore();
const { windowInitData } = storeToRefs(appStore) as { windowInitData: Ref<UploadConflictWindowPayload | null> };
const currentWindow = getCurrentWindow();
const payload = ref<UploadConflictWindowPayload | null>(null);
const applyToAll = ref(false);

watch(
    windowInitData,
    (data) => {
        if (data) payload.value = data;
    },
    { immediate: true },
);

currentWindow.listen<UploadConflictWindowPayload>(UPLOAD_CONFLICT_DATA_EVENT, async ({ payload: data }) => {
    payload.value = data;
});

async function choose(action: UploadConflictAction) {
    if (!payload.value) return;
    await emit<UploadConflictResolvedPayload>(UPLOAD_CONFLICT_RESOLVED_EVENT, {
        taskId: payload.value?.taskId ?? "",
        action,
        applyToAll: applyToAll.value,
    });
    if (payload.value.last || applyToAll.value) {
        await currentWindow.destroy();
    }
}

currentWindow.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, async () => {
    await emit<UploadConflictResolvedPayload>(UPLOAD_CONFLICT_RESOLVED_EVENT, {
        taskId: payload.value?.taskId ?? "",
        action: "cancel",
        applyToAll: true,
    });
    await currentWindow.destroy();
});
</script>

<template>
    <main class="upload-conflict-page">
        <section class="upload-conflict-card">
            <header class="upload-conflict-header">
                <div class="upload-conflict-icon" aria-hidden="true">
                    <Icon icon="lucide:files" />
                </div>
                <div class="upload-conflict-heading">
                    <h1 class="upload-conflict-title">远程文件已存在</h1>
                    <p class="upload-conflict-subtitle">上传的文件与远程路径冲突，请选择处理方式。</p>
                </div>
            </header>

            <div v-if="payload" class="upload-conflict-paths">
                <div class="upload-conflict-path">
                    <span class="upload-conflict-path-label">本地</span>
                    <p class="upload-conflict-path-value" :title="payload.localPath">{{ payload.localPath }}</p>
                </div>
                <div class="upload-conflict-path">
                    <span class="upload-conflict-path-label">远程</span>
                    <p class="upload-conflict-path-value" :title="payload.remotePath">{{ payload.remotePath }}</p>
                </div>
            </div>

            <label class="upload-conflict-apply">
                <input v-model="applyToAll" type="checkbox" />
                <span>应用到全部冲突文件</span>
            </label>

            <footer class="upload-conflict-actions">
                <button type="button" class="upload-conflict-btn secondary" @click="choose('skip')">跳过</button>
                <button type="button" class="upload-conflict-btn" @click="choose('copy')">保留副本</button>
                <button type="button" class="upload-conflict-btn primary" @click="choose('overwrite')">覆盖</button>
            </footer>
        </section>
    </main>
</template>

<style scoped lang="scss">
.upload-conflict-page {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 12px;
    display: flex;
}

.upload-conflict-card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-radius: 12px;
    padding: 27px 16px 12px;
}

.upload-conflict-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
}

.upload-conflict-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    font-size: 18px;
}

.upload-conflict-heading {
    min-width: 0;
}

.upload-conflict-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 600;
    line-height: 1.3;
}

.upload-conflict-subtitle {
    margin: 4px 0 0;
    font-size: var(--font-size-sm);
    line-height: 1.45;
}

.upload-conflict-paths {
    margin-top: 12px;
    display: grid;
    gap: 8px;
}

.upload-conflict-path {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 8px 10px;
    border-radius: 8px;
}

.upload-conflict-path-label {
    font-size: var(--font-size-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.6;
}

.upload-conflict-path-value {
    margin: 0;
    font-size: var(--font-size-sm);
    line-height: 1.4;
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.upload-conflict-apply {
    margin-top: 12px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    user-select: none;

    input {
        width: 14px;
        height: 14px;
        margin: 0;
        cursor: pointer;
    }
}

.upload-conflict-actions {
    margin-top: auto;
    padding-top: 14px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.upload-conflict-btn {
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 6px 14px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition:
        background 140ms ease,
        border-color 140ms ease,
        color 140ms ease;

    &:hover {
        filter: brightness(1.06);
    }
}
</style>
