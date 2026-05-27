import mitt, { type Emitter } from "mitt";
import { onUnmounted } from "vue";

export const DirectRemotePathEventKey = "DirectRemotePathEventKey"; // 直接打开远程路径事件
export const RefreshFileListEventKey = "RefreshFileListEventKey"; // 刷新文件列表事件
export const DownloadMenuOpenEventKey = "DownloadMenuOpenEventKey"; // 下载菜单打开事件
export const ActiveFileEventKey = "ActiveFileEventKey"; // 选择目录事件
export const FileDragStartEventKey = "FileDragStartEventKey"; // 文件拖拽开始事件
export const FileDragEndEventKey = "FileDragEndEventKey"; // 文件拖拽结束事件
export const SftpProcessEventKey = "SftpProcessEventKey"; // sftp非上传下载时的传输进度事件
export const TermGroupCommandEventKey = "TermGroupCommandEventKey"; // 终端组命令事件

export type BusEvents = {
    [DirectRemotePathEventKey]: { sid: string; path: string };
    [RefreshFileListEventKey]: void;
    [DownloadMenuOpenEventKey]: void;
    [ActiveFileEventKey]: { sid: string; path: string };
    [FileDragStartEventKey]: RemoteFileItem[];
    [FileDragEndEventKey]: void;
    [SftpProcessEventKey]: number;
    [TermGroupCommandEventKey]: { groupId: string; command: string; sessionId: string };
};

const emitter: Emitter<BusEvents> = mitt<BusEvents>();

export function useBus() {
    const cleanupTasks: Array<() => void> = [];

    const on = <K extends keyof BusEvents>(type: K, handler: (event: BusEvents[K]) => void) => {
        emitter.on(type, handler as (event: unknown) => void);
        const cleanup = () => emitter.off(type, handler as (event: unknown) => void);
        cleanupTasks.push(cleanup);
        return cleanup;
    };

    onUnmounted(() => {
        cleanupTasks.forEach((cleanup) => cleanup());
    });

    return {
        on,
        off: emitter.off,
        emit: emitter.emit,
        all: emitter.all,
    };
}

export default useBus;
