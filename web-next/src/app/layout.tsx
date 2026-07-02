/* eslint-disable @next/next/no-sync-scripts */
import "@/utils";
import "@/styles/css/global.css";
import "@/styles/css/font-size.css";
import "@/styles/scss/global.scss";
import "@/styles/scss/theme.nt.scss";
import "@/styles/scss/theme.glass.scss";
import "@xterm/xterm/css/xterm.css";
import "monaco-editor/min/vs/editor/editor.main.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
    title: "Keray Shell",
};

export default function RootLayout({ children }: { children: ReactNode }) {
    const enableReactDevTools = process.env.NODE_ENV === "development";
    return (
        <html lang="zh-CN">
            <body>
                {enableReactDevTools && <script src="http://localhost:8097"></script>}
                {/* 保留 Vue 版入口的 #app 根节点，让迁移过来的全局样式和玻璃主题选择器继续生效。 */}
                {children}
            </body>
        </html>
    );
}
