type MonacoAmdGlobal = typeof globalThis & {
    define?: (moduleName: string, factory: () => void) => void;
    _VSCODE_NLS_LANGUAGE?: string;
    _VSCODE_NLS_MESSAGES?: string[];
};

const monacoAmdGlobal = globalThis as MonacoAmdGlobal;
const previousDefine = monacoAmdGlobal.define;

monacoAmdGlobal.define = (_moduleName, factory) => factory();

await import("monaco-editor/min/vs/nls.messages.zh-cn.js.js");

if (previousDefine) {
    monacoAmdGlobal.define = previousDefine;
} else {
    delete monacoAmdGlobal.define;
}
