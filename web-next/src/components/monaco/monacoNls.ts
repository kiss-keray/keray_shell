type MonacoAmdGlobal = typeof globalThis & {
    define?: (moduleName: string, factory: () => void) => void;
    _VSCODE_NLS_LANGUAGE?: string;
    _VSCODE_NLS_MESSAGES?: string[];
};

const monacoAmdGlobal = globalThis as MonacoAmdGlobal;
const previousDefine = monacoAmdGlobal.define;

// Monaco 的 NLS 包以 AMD define 注册；临时提供 define 后立即恢复，避免污染其它运行时代码。
monacoAmdGlobal.define = (_moduleName, factory) => factory();

await import("monaco-editor/min/vs/nls.messages.zh-cn.js.js");

if (previousDefine) {
    monacoAmdGlobal.define = previousDefine;
} else {
    delete monacoAmdGlobal.define;
}

export {};
