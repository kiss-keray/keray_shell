<script setup lang="ts">
import { join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Markdown, type DownloadEvent } from "vue-stream-markdown";
import "vue-stream-markdown/index.css";

/**
 * 助手正文用 vue-stream-markdown 流式渲染。
 * 代码块自带 header 操作区；主题里把复制按钮叠到 pre 右上角，并关掉下载/全屏以免挡命令。
 */
defineOptions({ name: "AgentMessageResponse" });

defineProps<{ content: string }>();

const configStore = useConfigStore();
const isDark = computed(() => configStore.themeMode === "dark");

/** 运维对话只保留复制，避免代码块 header 挤满无关按钮。 */
const markdownControls = {
    code: {
        copy: true,
        download: false,
        fullscreen: false,
        collapse: false,
    },
};

/**
 * 表格下载事件只带正文、不带扩展名；按内容形态还原 csv/tsv/md，才能弹出对应的保存对话框。
 */
function tableFileExt(content: string): "csv" | "tsv" | "md" {
    const firstLine = content.split("\n", 1)[0] ?? "";
    if (firstLine.startsWith("|")) return "md";
    if (firstLine.includes("\t")) return "tsv";
    return "csv";
}

/**
 * 拦截 markdown 默认的 <a download>：Tauri 里拿不到落盘路径。
 * 改用系统保存框写入本地文件，成功后再 toast 路径；返回 false 阻止浏览器下载。
 */
async function beforeDownload(event: DownloadEvent): Promise<boolean> {
    if (event.type !== "table") return true;
    const ext = tableFileExt(event.content);
    const dir = configStore.downloadDir.replace(/[\\/]+$/, "");
    const defaultPath = dir ? await join(dir, `table.${ext}`) : `table.${ext}`;
    try {
        const path = await save({
            title: "保存表格",
            defaultPath,
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });
        if (!path) return false;
        await writeTextFile(path, event.content, { create: true });
        showToast(`下载成功\n${path}`, "success");
    } catch (error) {
        showToast(error instanceof Error ? error.message : "下载失败", "error");
    }
    return false;
}
</script>

<template>
    <!--
      固定 static 模式。库默认 streaming 会把最后一个块的末尾文本标记为 loading，
      表格收尾时下方会一直挂着加载圈；且流结束后切 mode 也不会刷新（updateMode 原地改节点，
      Vue computed 依赖 node 引用不重算，1.0.4 的缺陷）。static 没有 loading 残留，
      代价是流式文字淡入动画和半截语法补全失效。
    -->
    <Markdown
        class="ai-message-response"
        :class="{ dark: isDark }"
        mode="static"
        :content="content"
        :is-dark="isDark"
        :controls="markdownControls"
        :before-download="beforeDownload"
    />
</template>
