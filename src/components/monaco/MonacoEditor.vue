<script setup lang="ts">
import { storeToRefs } from "pinia";
import { defineKerayMonacoTheme, languageFromPath, monaco } from "@/components/monaco/monacoEnv";
import "monaco-editor/min/vs/editor/editor.main.css";
import { DEFAULT_FONT_FAMILY } from "@/utils/constant";

defineOptions({
    name: "MonacoEditor",
});

/** 单个打开文件的模型描述 */
export type MonacoEditorModelSpec = {
    key: string;
    path: string;
    content: string;
    language?: string;
    readOnly?: boolean;
};

const props = defineProps<{
    /** 当前 editor 负责的单个文件 */
    file: MonacoEditorModelSpec;
}>();

const emit = defineEmits<{
    /** 文本变更：回传最新内容 */
    change: [content: string];
    /** Ctrl/Cmd + S */
    save: [];
    ready: [];
}>();

const configStore = useConfigStore();
const { themeMode, fontSize, termFontFamily } = storeToRefs(configStore);

const hostRef = ref<HTMLElement | null>(null);
const editorRef = shallowRef<monaco.editor.IStandaloneCodeEditor | null>(null);
const modelRef = shallowRef<monaco.editor.ITextModel | null>(null);

let saveAction: monaco.IDisposable | null = null;
let contentListener: monaco.IDisposable | null = null;
let resizeObserver: ResizeObserver | null = null;

/** 构建 model URI，便于 Monaco 按语言提供语法服务 */
function modelUri(path: string) {
    const lang = languageFromPath(path);
    return monaco.Uri.parse(`file:///${path.replace(/^\//, "")}.${lang === "shell" ? "txt" : lang}`);
}

/** 同步外部文件状态到当前 editor 的 model */
function syncModelContent() {
    const editor = editorRef.value;
    const model = modelRef.value;
    const spec = props.file;
    if (!editor || !model) return;

    if (model.getValue() !== spec.content) {
        model.setValue(spec.content);
    }
    monaco.editor.setModelLanguage(model, spec.language ?? languageFromPath(spec.path));
    editor.updateOptions({ readOnly: Boolean(spec.readOnly) });
}

/** 初始化 Monaco 实例 */
function initEditor() {
    const host = hostRef.value;
    if (!host || editorRef.value) return;

    defineKerayMonacoTheme(document.documentElement, themeMode.value);

    const editor = monaco.editor.create(host, {
        model: monaco.editor.createModel(props.file.content, props.file.language ?? languageFromPath(props.file.path), modelUri(props.file.path)),
        automaticLayout: false,
        fontSize: fontSize.value,
        fontFamily: termFontFamily.value || DEFAULT_FONT_FAMILY,
        lineHeight: Math.round(fontSize.value * 1.45),
        minimap: { enabled: true, scale: 0.5 },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        tabSize: 4,
        insertSpaces: true,
        renderWhitespace: "selection",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        padding: { top: 8, bottom: 8 },
        overviewRulerLanes: 0,
    });

    editorRef.value = editor;
    modelRef.value = editor.getModel();

    // 注册保存快捷键（Ctrl/Cmd + S）
    saveAction = editor.addAction({
        id: "keray-save",
        label: "保存",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
            emit("save");
        },
    });

    contentListener = editor.onDidChangeModelContent(() => {
        const model = editor.getModel();
        if (!model) return;
        emit("change", model.getValue());
    });

    resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(host);

    syncModelContent();
    emit("ready");
}

/** 读取当前文件的最新内容（保存时使用） */
function getContent(): string {
    return modelRef.value?.getValue() ?? props.file.content;
}

defineExpose({
    getContent,
    focus: () => editorRef.value?.focus(),
});

watch(
    () => props.file,
    () => syncModelContent(),
    { deep: true },
);

watch(themeMode, (mode) => {
    defineKerayMonacoTheme(document.documentElement, mode);
});

watch([fontSize, termFontFamily], ([size, family]) => {
    editorRef.value?.updateOptions({
        fontSize: size,
        lineHeight: Math.round(size * 1.45),
        fontFamily: family || DEFAULT_FONT_FAMILY,
    });
});

onMounted(() => {
    initEditor();
});

onBeforeUnmount(() => {
    saveAction?.dispose();
    contentListener?.dispose();
    resizeObserver?.disconnect();
    modelRef.value?.dispose();
    modelRef.value = null;
    editorRef.value?.dispose();
    editorRef.value = null;
});
</script>

<template>
    <div ref="hostRef" class="monaco-editor-host"></div>
</template>

<style scoped lang="scss">
.monaco-editor-host {
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
}
</style>
<style lang="scss">
.monaco-editor-host {
    .monaco-editor,
    .monaco-editor-background,
    .margin {
        background-color: transparent !important;
    }
    .view-overlays {
        > div {
            background-color: transparent !important;
        }
        .current-line {
            background-color: transparent !important;
        }
    }
    .minimap {
        left: unset !important;
        right: 0px !important;
        width: 60px !important;
        backdrop-filter: blur(1px);
    }
}
</style>
