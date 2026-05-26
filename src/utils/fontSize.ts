/** 默认 UI 基准字号，与 `initialState.fontSize` 一致 */
export const DEFAULT_UI_FONT_SIZE = 12;

/**
 * 将配置中的基准字号应用到 `:root` CSS 变量。
 * 各档字号通过 `font-size.css` 中的 calc 比例自动缩放。
 */
export function applyUiFontSize(basePx: number) {
    const base = Math.max(8, Math.min(32, basePx));
    const root = document.documentElement;
    root.style.setProperty("--font-size-base", `${base}px`);
    root.style.fontSize = `${base}px`;
}

/** 读取已应用的 CSS 字号变量（用于 JS 动态样式） */
export function getUiFontSizeCss(varName = "--font-size-md"): string {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}
