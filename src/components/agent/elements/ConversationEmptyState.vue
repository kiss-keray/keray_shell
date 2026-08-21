<script setup lang="ts">
/**
 * AI Elements Vue ConversationEmptyState 的项目内版本。
 * 空会话时展示运维助手引导，并统一维护默认与用户自定义的常用问题。
 */
defineOptions({ name: "AgentConversationEmptyState" });

/** 默认常用问题覆盖 Linux 运维最常见的巡检入口。 */
const DEFAULT_SUGGESTIONS = [
    "检查当前系统的 CPU、内存和负载",
    "分析磁盘空间与 inode 占用",
    "查看最近的系统错误日志",
    "检查网络连通性与监听端口",
];
const CUSTOM_SUGGESTIONS_CACHE_KEY = "AGENT_CUSTOM_SUGGESTIONS";
const MAX_CUSTOM_SUGGESTION_LENGTH = 100;
const MAX_CUSTOM_SUGGESTIONS = 20;

const emit = defineEmits<{
    (e: "submit", text: string): void;
}>();

const props = withDefaults(defineProps<{ title?: string; description?: string; disabled?: boolean }>(), {
    title: "今天想处理什么？",
    description: "我可以协助分析服务器状态、整理运维步骤，并在执行工具时展示实时进度。",
    disabled: false,
});

const localStore = useLocalStore();
const customSuggestions = ref<string[]>([]);
const customQuestion = ref("");
const adding = ref(false);
const cacheReady = ref(false);
const addInputRef = ref<HTMLTextAreaElement>();

const trimmedQuestion = computed(() => customQuestion.value.trim());
const canAddCustomQuestion = computed(() => {
    const question = trimmedQuestion.value;
    return (
        Boolean(question) &&
        !DEFAULT_SUGGESTIONS.includes(question) &&
        !customSuggestions.value.includes(question) &&
        customSuggestions.value.length < MAX_CUSTOM_SUGGESTIONS
    );
});

/**
 * 缓存只接受去空白、非重复的字符串，避免旧版本或手动编辑产生的异常数据进入按钮列表。
 * 自定义项设为 20 条上限，防止空状态无限增长挤压对话区域。
 */
function cleanCachedSuggestions(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const unique = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const question = item.trim().slice(0, MAX_CUSTOM_SUGGESTION_LENGTH).trim();
        if (!question || DEFAULT_SUGGESTIONS.includes(question)) continue;
        unique.add(question);
        if (unique.size >= MAX_CUSTOM_SUGGESTIONS) break;
    }
    return [...unique];
}

async function persistCustomSuggestions() {
    try {
        await localStore.writeCache(CUSTOM_SUGGESTIONS_CACHE_KEY, customSuggestions.value);
    } catch (error) {
        // 缓存失败不影响当前窗口继续使用，保留日志供定位文件权限等环境问题。
        console.warn("save custom agent suggestions error:", error);
    }
}

function submitSuggestion(question: string) {
    if (props.disabled) return;
    emit("submit", question);
}

async function startAdding() {
    adding.value = true;
    await nextTick();
    // 重新展开时上次的高度还残留在 style 上，先按空内容重置回最小行数。
    resizeAddInput();
    addInputRef.value?.focus();
}

/**
 * textarea 高度随内容自动伸缩：先收回 auto 让内容决定 scrollHeight，再写回显式高度。
 * 最少 2 行、最多 20 行的上下限由 CSS min/max-height 钳制，超出后由 textarea 自身滚动。
 */
function resizeAddInput() {
    const textarea = addInputRef.value;
    if (!textarea) return;
    textarea.style.height = "auto";
    // border-box 下 scrollHeight 不含边框，补 2px 避免 glass 主题的 1px 边框造成高度抖动。
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

function cancelAdding() {
    adding.value = false;
    customQuestion.value = "";
}

function addCustomQuestion() {
    if (!canAddCustomQuestion.value) return;
    customSuggestions.value.push(trimmedQuestion.value);
    void persistCustomSuggestions();
    cancelAdding();
}

function removeCustomQuestion(question: string) {
    customSuggestions.value = customSuggestions.value.filter((item) => item !== question);
    void persistCustomSuggestions();
}

onMounted(async () => {
    try {
        const cached = await localStore.readCache<unknown>(CUSTOM_SUGGESTIONS_CACHE_KEY);
        customSuggestions.value = cleanCachedSuggestions(cached);
    } catch (error) {
        // 读取失败时仍展示默认问题，并允许用户在当前窗口继续添加。
        console.warn("load custom agent suggestions error:", error);
    } finally {
        // 缓存读取结束前不开放编辑，避免用户刚添加的问题被迟到的读取结果覆盖。
        cacheReady.value = true;
    }
});
</script>

<template>
    <div class="ai-conversation-empty">
        <span class="ai-conversation-empty-icon">
            <slot name="icon"><Icon icon="mdi:robot-outline" /></slot>
        </span>
        <h2>{{ title }}</h2>
        <p>{{ description }}</p>
        <div class="ai-conversation-empty-actions">
            <div class="ai-suggestions" role="group" aria-label="常用问题">
                <!-- 默认问题直接提交；自定义问题额外提供独立删除按钮，避免误删时触发提交。 -->
                <button
                    v-for="item in DEFAULT_SUGGESTIONS"
                    :key="item"
                    type="button"
                    class="ai-suggestion"
                    :disabled="disabled"
                    :title="item"
                    @click="submitSuggestion(item)"
                >
                    <span class="ai-suggestion-text">{{ item }}</span>
                </button>
                <span v-for="item in customSuggestions" :key="item" class="ai-custom-suggestion">
                    <button type="button" class="ai-suggestion" :disabled="disabled" :title="item" @click="submitSuggestion(item)">
                        <span class="ai-suggestion-text">{{ item }}</span>
                    </button>
                    <button
                        type="button"
                        class="ai-suggestion-remove"
                        :title="`删除常用问题：${item}`"
                        :aria-label="`删除常用问题：${item}`"
                        @click="removeCustomQuestion(item)"
                    >
                        <Icon icon="mdi:close" />
                    </button>
                </span>
            </div>

            <!-- 添加表单只在需要时展开，减少空状态中的常驻视觉噪音。 -->
            <!-- 输入框使用 textarea 支持长问题换行预览；Enter 直接保存，Shift+Enter 才换行，保持与原 input 一致的提交习惯。 -->
            <form v-if="adding" class="ai-suggestion-form" @submit.prevent="addCustomQuestion">
                <textarea
                    ref="addInputRef"
                    v-model="customQuestion"
                    rows="2"
                    autocomplete="off"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    :maxlength="MAX_CUSTOM_SUGGESTION_LENGTH"
                    placeholder="输入自定义常用问题，Enter 保存，Shift+Enter 换行"
                    aria-label="自定义常用问题"
                    @input="resizeAddInput"
                    @keydown.enter.exact.prevent="addCustomQuestion"
                    @keydown.esc.prevent="cancelAdding"
                ></textarea>
                <button type="submit" class="ai-suggestion-form-action" title="保存" aria-label="保存" :disabled="!canAddCustomQuestion">
                    <Icon icon="mdi:check" />
                </button>
                <button type="button" class="ai-suggestion-form-action" title="取消" aria-label="取消" @click="cancelAdding">
                    <Icon icon="mdi:close" />
                </button>
            </form>
            <button
                v-else
                type="button"
                class="ai-suggestion-add"
                :disabled="!cacheReady || customSuggestions.length >= MAX_CUSTOM_SUGGESTIONS"
                @click="startAdding"
            >
                <Icon icon="mdi:plus" />
                <span>{{ customSuggestions.length >= MAX_CUSTOM_SUGGESTIONS ? "已达常用问题上限" : "添加常用问题" }}</span>
            </button>
        </div>
    </div>
</template>

<style scoped lang="scss">
.ai-conversation-empty {
    display: flex;
    flex: 1;
    min-height: 280px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    padding: 30px;
    text-align: center;
    h2 {
        margin: 16px 0 7px;
        font-size: clamp(20px, 4vw, 28px);
    }
    p {
        max-width: 500px;
        margin: 0;
        line-height: 1.65;
    }
}
.ai-conversation-empty-icon {
    display: inline-flex;
    width: 54px;
    height: 54px;
    align-items: center;
    justify-content: center;
    border-radius: 18px;
    font-size: 28px;
}
.ai-conversation-empty-actions {
    display: flex;
    width: 100%;
    max-width: 640px;
    margin-top: 22px;
    align-items: center;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
}
.ai-suggestions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
}
/* 常用问题按钮布局；颜色主题在 theme.*.scss 的 .agent-panel 一级作用域中。 */
.ai-suggestion,
.ai-suggestion-add,
.ai-suggestion-form-action {
    display: inline-flex;
    flex: none;
    max-width: 100%;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-sm);
    line-height: 1.4;
    &:disabled {
        cursor: default;
        opacity: 0.55;
    }
}
.ai-suggestion {
    padding: 7px 12px;
    overflow-wrap: anywhere;
}
/* 单个问题文字最多显示两排，超出以省略号截断，防止长问题把按钮撑得过高；完整内容通过按钮 title 悬浮查看。 */
.ai-suggestion-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
}
.ai-custom-suggestion {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 2px;
    .ai-suggestion {
        flex: 1;
        min-width: 0;
    }
}
.ai-suggestion-remove,
.ai-suggestion-form-action {
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
}
.ai-suggestion-remove {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    font-size: 14px;
}
.ai-suggestion-add {
    gap: 5px;
    padding: 6px 11px;
}
.ai-suggestion-form {
    display: flex;
    width: min(100%, 420px);
    align-items: center;
    gap: 6px;
    /*
     * 多行输入框高度随行数变化，用固定小圆角替代胶囊形，避免两行以上时两端弧度变形。
     * 高度区间由 JS 在 input 时写入，这里只做钳制：最少 2 行（2.8em）、最多 20 行（28em），
     * 均加上下 padding 16px 与边框 2px；达到上限后超出内容在框内滚动。
     */
    textarea {
        flex: 1;
        min-width: 0;
        min-height: calc(2.8em + 18px);
        max-height: calc(28em + 18px);
        padding: 8px 12px;
        border-radius: 17px;
        outline: none;
        resize: none;
        font: inherit;
        font-size: var(--font-size-sm);
        line-height: 1.4;
    }
}
</style>
