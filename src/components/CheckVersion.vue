<script setup lang="ts">
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

defineOptions({
    name: "CheckVersion",
});

// 检查最新版本的url
const GITHUB_RELEASE_LATEST_API = "https://api.github.com/repos/kiss-keray/keray_shell/releases/latest";
// 新版本下载的url
const GITHUB_RELEASE_TAG_URL = "https://github.com/kiss-keray/keray_shell/releases/tag/";
// 忽略的版本号key
const IGNORED_RELEASE_TAG_KEY = "keray_shell_ignored_release_tag";

/** GitHub latest release API 当前只用这些字段，避免把接口响应结构扩散到组件外。 */
type GithubLatestRelease = {
    tag_name?: string;
    name?: string;
    html_url?: string;
    published_at?: string;
};
const localStore = useLocalStore();

const visible = ref(false);
const checking = ref(false);
const currentVersion = ref("");
const latestRelease = ref<GithubLatestRelease | null>(null);

/** tag 可能是 0.1.5 或 v0.1.5，展示时保留 GitHub 原始 tag。 */
const latestTag = computed(() => latestRelease.value?.tag_name?.trim() || "");
const releaseUrl = computed(() => {
    if (!latestTag.value) return "";
    return latestRelease.value?.html_url || `${GITHUB_RELEASE_TAG_URL}${encodeURIComponent(latestTag.value)}`;
});
/** GitHub 返回 UTC 时间，这里交给系统本地化，和用户系统语言/时区保持一致。 */
const publishedText = computed(() => {
    const publishedAt = latestRelease.value?.published_at;
    if (!publishedAt) return "";
    const date = new Date(publishedAt);
    return Number.isNaN(date.getTime()) ? publishedAt : date.toLocaleString();
});

onMounted(() => {
    // 等主窗口基础样式和全局事件完成初始化后再检查，避免更新弹窗打断首屏渲染。
    window.setTimeout(() => {
        void checkVersion();
    }, 800);
});

/** 检查流程：本地版本 + GitHub 最新版本并发读取，然后按忽略记录和版本大小决定是否弹窗。 */
async function checkVersion() {
    if (checking.value) return;
    checking.value = true;
    try {
        const [localVersion, release] = await Promise.all([getVersion(), fetchLatestRelease()]);
        if (!release?.tag_name) return;

        const releaseTag = release.tag_name.trim();
        // 用户选择“忽略此版本”后，只跳过同一个 tag；下一次发布新 tag 时会重新提醒。
        const ignoredReleaseTag = await localStore.readCache<string>(IGNORED_RELEASE_TAG_KEY);
        if (ignoredReleaseTag === releaseTag) return;
        currentVersion.value = localVersion;
        latestRelease.value = release;
        if (compareVersion(normalizeVersion(releaseTag), localVersion) > 0) {
            visible.value = true;
        }
    } catch (err) {
        // 版本检查失败不应影响主流程，只在控制台保留排查信息。
        console.warn("check new version error:", err);
    } finally {
        checking.value = false;
    }
}

/** 单独封装 GitHub 请求，后续如果要切换代理或加缓存，只需要改这里。 */
async function fetchLatestRelease(): Promise<GithubLatestRelease | null> {
    const response = await fetch(GITHUB_RELEASE_LATEST_API, {
        headers: {
            Accept: "application/vnd.github+json",
        },
    });
    if (!response.ok) return null;
    return (await response.json()) as GithubLatestRelease;
}

async function openRelease() {
    visible.value = false;
    if (releaseUrl.value) {
        await openUrl(releaseUrl.value);
    }
}

function closeDialog() {
    visible.value = false;
}

function ignoreRelease() {
    if (latestTag.value) {
        void localStore.writeCache(IGNORED_RELEASE_TAG_KEY, latestTag.value);
    }
    visible.value = false;
}

/** 兼容 GitHub tag 常见的 v 前缀，比较时只使用纯版本号。 */
function normalizeVersion(version: string) {
    return version.trim().replace(/^v/i, "");
}

/**
 * 轻量语义化版本比较。
 *
 * 这里只需要判断远端 release 是否比当前安装包新，因此按数字段逐段比较即可；
 * pre-release/build metadata 会被拆分后忽略非数字段，避免复杂版本号导致检查流程报错。
 */
function compareVersion(a: string, b: string) {
    const aParts = parseVersion(a);
    const bParts = parseVersion(b);
    const length = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < length; i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

/** 将 0.1.5 / v0.1.5 / 0.1.5-beta 解析成可比较的数字段。 */
function parseVersion(version: string) {
    return normalizeVersion(version)
        .split(/[.-]/)
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => !Number.isNaN(part));
}
</script>

<template>
    <Teleport to="body">
        <Transition name="check-version-fade">
            <div v-if="visible" class="check-version check-version-mask">
                <section class="check-version-dialog" role="dialog" aria-modal="true" aria-labelledby="check-version-title" @click.stop>
                    <div class="check-version-icon-wrap">
                        <Icon icon="lucide:sparkles" class="check-version-icon" />
                    </div>
                    <div class="check-version-content">
                        <p id="check-version-title" class="check-version-title">发现新版本</p>
                        <p class="check-version-desc">keray_shell 已发布可下载的新版本。</p>

                        <dl class="check-version-meta">
                            <div class="check-version-meta-row">
                                <dt>当前版本</dt>
                                <dd>{{ currentVersion }}</dd>
                            </div>
                            <div class="check-version-meta-row">
                                <dt>最新版本</dt>
                                <dd>{{ latestTag }}</dd>
                            </div>
                            <div v-if="publishedText" class="check-version-meta-row">
                                <dt>发布时间</dt>
                                <dd>{{ publishedText }}</dd>
                            </div>
                        </dl>
                    </div>

                    <div class="check-version-actions">
                        <button type="button" class="check-version-btn ghost" @click="ignoreRelease">忽略此版本</button>
                        <button type="button" class="check-version-btn secondary" @click="closeDialog">下次提醒</button>
                        <button type="button" class="check-version-btn primary" @click="openRelease">
                            <Icon icon="lucide:download" class="check-version-btn-icon" />
                            立即下载
                        </button>
                    </div>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped lang="scss">
.check-version-mask {
    position: fixed;
    inset: 0;
    z-index: 3200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
}

.check-version-dialog {
    width: min(430px, 100%);
    padding: 18px;
    border-radius: 10px;
}

.check-version-icon-wrap {
    width: 42px;
    height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
}

.check-version-icon {
    width: 23px;
    height: 23px;
}

.check-version-content {
    margin-top: 12px;
}

.check-version-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 650;
}

.check-version-desc {
    margin: 6px 0 0;
    font-size: var(--font-size-md);
    line-height: 1.45;
}

.check-version-meta {
    margin: 14px 0 0;
    padding: 0;
    border-radius: 8px;
    overflow: hidden;
}

.check-version-meta-row {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    padding: 9px 12px;

    &:last-child {
        border-bottom: none;
    }

    dt,
    dd {
        margin: 0;
        min-width: 0;
        line-height: 1.4;
        word-break: break-word;
    }

    dd {
        font-weight: 560;
    }
}

.check-version-actions {
    margin-top: 16px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
}

.check-version-btn {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
    border: none;
    border-radius: 7px;
    font-size: var(--font-size-md);
    line-height: 1;
    cursor: pointer;

    &.primary {
        font-weight: 650;
    }

    &:hover {
        filter: brightness(1.06);
    }
}

.check-version-btn-icon {
    width: 16px;
    height: 16px;
}

.check-version-fade-enter-active,
.check-version-fade-leave-active {
    transition: opacity 150ms ease;
}

.check-version-fade-enter-from,
.check-version-fade-leave-to {
    opacity: 0;
}
</style>
