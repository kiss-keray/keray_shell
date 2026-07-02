if (typeof self !== "undefined") {
    // Monaco worker 必须在加载 monaco-editor 前配置；Next 静态导出下用 URL 交给打包器处理本地 worker。
    self.MonacoEnvironment = {
        getWorker(_: unknown, label: string) {
            if (label === "json") return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
            if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
            if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
            if (label === "typescript" || label === "javascript") return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
            return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
        },
    };
}

/** 扩展名 → Monaco 语言 ID */
const EXT_LANGUAGE_MAP: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    jsonc: "json",
    html: "html",
    htm: "html",
    vue: "html",
    xml: "xml",
    css: "css",
    scss: "scss",
    sass: "scss",
    less: "less",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    kts: "kotlin",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    yml: "yaml",
    yaml: "yaml",
    sql: "sql",
    php: "php",
    rb: "ruby",
    swift: "swift",
    dart: "dart",
    lua: "lua",
    r: "r",
    toml: "ini",
    ini: "ini",
    conf: "ini",
    cfg: "ini",
    dockerfile: "dockerfile",
    gql: "graphql",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
    hcl: "hcl",
    ps1: "powershell",
    bat: "bat",
    cmd: "bat",
};

/** 根据文件路径推断 Monaco 语言；无匹配时回退 shell。 */
export function languageFromPath(filePath: string): string {
    const base = filePath.split("/").pop() ?? filePath;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) {
        if (base.toLowerCase() === "dockerfile") return "dockerfile";
        if (base.toLowerCase() === "makefile") return "makefile";
        return "shell";
    }
    const ext = base.slice(dot + 1).toLowerCase();
    return EXT_LANGUAGE_MAP[ext] ?? "shell";
}

export function defineKerayMonacoTheme(monaco: typeof import("monaco-editor"), themeRoot: HTMLElement, themeMode: "dark" | "light") {
    const css = getComputedStyle(themeRoot);
    const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const themeName = `keray-${themeMode}`;
    const isDark = themeMode === "dark";

    monaco.editor.defineTheme(themeName, {
        base: isDark ? "hc-black" : "hc-light",
        inherit: true,
        rules: [],
        colors: {
            "editor.background": pick("--monaco-bg", isDark ? "#1e1e1e" : "#ffffff"),
            "editor.foreground": pick("--monaco-fg", isDark ? "#d4d4d4" : "#1e1e1e"),
            "editorLineNumber.foreground": pick("--monaco-line-number", isDark ? "#858585" : "#237893"),
            "editorLineNumber.activeForeground": pick("--monaco-line-number-active", isDark ? "#c6c6c6" : "#0b216f"),
            "editor.selectionBackground": pick("--monaco-selection", isDark ? "#264f78" : "#add6ff"),
            "editor.inactiveSelectionBackground": pick("--monaco-selection-inactive", isDark ? "#3a3d41" : "#e5ebf1"),
            "editorCursor.foreground": pick("--monaco-cursor", isDark ? "#aeafad" : "#000000"),
            "editor.lineHighlightBackground": pick("--monaco-line-highlight", isDark ? "#2a2d2e" : "#f3f3f3"),
            "editorIndentGuide.background": pick("--monaco-indent-guide", isDark ? "#404040" : "#d3d3d3"),
            "editorWidget.background": pick("--monaco-widget-bg", isDark ? "#252526" : "#f3f3f3"),
            "editorWidget.border": pick("--monaco-widget-border", isDark ? "#454545" : "#c8c8c8"),
            "editorSuggestWidget.background": pick("--monaco-widget-bg", isDark ? "#252526" : "#f3f3f3"),
            "editorSuggestWidget.border": pick("--monaco-widget-border", isDark ? "#454545" : "#c8c8c8"),
            "editorSuggestWidget.selectedBackground": pick("--monaco-suggest-selected", isDark ? "#04395e" : "#0060c0"),
            "scrollbarSlider.background": pick("--monaco-scrollbar", isDark ? "#79797966" : "#64646466"),
            "scrollbarSlider.hoverBackground": pick("--monaco-scrollbar-hover", isDark ? "#646464b3" : "#646464b3"),
            "minimap.background": pick("--monaco-minimap-bg", isDark ? "#00000000" : "#ffffff00"),
        },
    });
    monaco.editor.setTheme(themeName);
    return themeName;
}
