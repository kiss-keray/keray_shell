"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useConfigStore } from "@/stores/config";
import { DEFAULT_FONT_FAMILY } from "@/utils/constant";
import { defineKerayMonacoTheme, languageFromPath } from "@/components/monaco/monacoEnv";
import "./index.scss";

/** 单个打开文件的模型描述 */
export type MonacoEditorModelSpec = {
    key: string;
    path: string;
    content: string;
    language?: string;
    readOnly?: boolean;
};

export type MonacoEditorExpose = {
    getContent: () => string;
    focus: () => void;
};

export type MonacoEditorProps = {
    file: MonacoEditorModelSpec;
    className?: string;
    style?: React.CSSProperties;
    onChange: (content: string) => void;
    onSave: () => void;
};

function modelUri(monaco: typeof import("monaco-editor"), path: string) {
    const lang = languageFromPath(path);
    return monaco.Uri.parse(`file:///${path.replace(/^\//, "")}.${lang === "shell" ? "txt" : lang}`);
}

const MonacoEditor = forwardRef<MonacoEditorExpose, MonacoEditorProps>(function MonacoEditor({ file, className, style, onChange, onSave }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
    const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
    const modelRef = useRef<import("monaco-editor").editor.ITextModel | null>(null);
    const fileRef = useRef(file);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const themeMode = useConfigStore((state) => state.themeMode);
    const fontSize = useConfigStore((state) => state.fontSize);
    const termFontFamily = useConfigStore((state) => state.termFontFamily);

    useImperativeHandle(ref, () => ({
        getContent: () => modelRef.current?.getValue() ?? fileRef.current.content,
        focus: () => editorRef.current?.focus(),
    }));

    function syncEditorFromFile() {
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        const model = modelRef.current;
        const currentFile = fileRef.current;
        if (!monaco || !editor || !model) return;
        if (model.getValue() !== currentFile.content) model.setValue(currentFile.content);
        monaco.editor.setModelLanguage(model, currentFile.language ?? languageFromPath(currentFile.path));
        editor.updateOptions({ readOnly: Boolean(currentFile.readOnly) });
    }

    useEffect(() => {
        let disposed = false;
        let resizeObserver: ResizeObserver | null = null;
        let saveAction: import("monaco-editor").IDisposable | null = null;
        let contentListener: import("monaco-editor").IDisposable | null = null;

        async function initEditor() {
            const host = hostRef.current;
            if (!host || editorRef.current) return;
            await import("@/components/monaco/monacoNls");
            const monaco = await import("monaco-editor");
            if (disposed) return;
            monacoRef.current = monaco;
            defineKerayMonacoTheme(monaco, document.documentElement, themeMode);
            // Monaco 通过异步 import 初始化；期间 file 可能已从“加载中”更新为真实内容，必须取最新 ref。
            const currentFile = fileRef.current;
            const model = monaco.editor.createModel(currentFile.content, currentFile.language ?? languageFromPath(currentFile.path), modelUri(monaco, currentFile.path));
            const editor = monaco.editor.create(host, {
                model,
                automaticLayout: false,
                fontSize,
                fontFamily: termFontFamily || DEFAULT_FONT_FAMILY,
                lineHeight: Math.round(fontSize * 1.45),
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
                readOnly: Boolean(currentFile.readOnly),
            });
            editorRef.current = editor;
            modelRef.current = model;
            saveAction = editor.addAction({
                id: "keray-save",
                label: "保存",
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
                run: () => onSaveRef.current(),
            });
            contentListener = editor.onDidChangeModelContent(() => {
                const nextModel = editor.getModel();
                if (nextModel) onChangeRef.current(nextModel.getValue());
            });
            resizeObserver = new ResizeObserver(() => editor.layout());
            resizeObserver.observe(host);
            syncEditorFromFile();
        }

        void initEditor();
        return () => {
            disposed = true;
            saveAction?.dispose();
            contentListener?.dispose();
            resizeObserver?.disconnect();
            modelRef.current?.dispose();
            editorRef.current?.dispose();
            modelRef.current = null;
            editorRef.current = null;
        };
        // Monaco 实例必须随 DOM host 只创建一次；内容、主题和字体通过后续 effects 同步。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        fileRef.current = file;
        syncEditorFromFile();
    }, [file]);

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        onSaveRef.current = onSave;
    }, [onSave]);

    useEffect(() => {
        const monaco = monacoRef.current;
        if (monaco) defineKerayMonacoTheme(monaco, document.documentElement, themeMode);
    }, [themeMode]);

    useEffect(() => {
        editorRef.current?.updateOptions({
            fontSize,
            lineHeight: Math.round(fontSize * 1.45),
            fontFamily: termFontFamily || DEFAULT_FONT_FAMILY,
        });
    }, [fontSize, termFontFamily]);

    return <div ref={hostRef} className={className ? `MonacoEditor monaco-editor-host ${className}` : "MonacoEditor monaco-editor-host"} style={style} />;
});

export default MonacoEditor;
