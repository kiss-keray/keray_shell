import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mkdir, readDir, stat } from "@tauri-apps/plugin-fs";
import { parentDirSlash, remoteJoin, remoteRemove } from "@/utils/fsUtil";
import { treeForMap, uuid } from "@/utils";
import { useConfigStore } from "./config";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { Channel } from "@tauri-apps/api/core";
import { openUploadConflictWindow, type UploadConflictAction } from "@/utils/window";

export type TransferStatus = "queued" | "running" | "paused" | "cancelled" | "success" | "error";
export type TransferKind = "upload" | "download";

/** 各终端 SFTP 面板注册后，传输完成/删文件时可刷新对应文件树与错误条 */
export type SftpPaneTransferBinding = {
    sessionId: string; // 终端 sessionID
    serverId: string; // 服务器存储的id
};

/** 文件字节信息 */
export type ByteProgressMeta = { loaded: number; total: number };

export type LoadingFlag = "none" | "stop";
type DownloadProgressPayload = {
    loaded: number;
    delta: number;
    total: number;
};

/** 单个文件的传输任务 */
export type TransferItem = {
    id: number; // 任务 ID 按顺序递增
    serverId: string; // 服务器Id
    kind: TransferKind; // 传输类型
    name: string; // 展示名（组为文件夹时为相对路径，否则为文件名)
    isDir: boolean; // 是否为文件夹
    remotePath: string; // 远端完整路径
    localPath: string; // 本地完整路径
    speedBps: number; // 传输速度
    remainingTime?: number; // 剩余时间(ms)
    status: TransferStatus; // 传输状态
    bps: Record<number, number>; // 网速缓存{时间点, 文件大小}
    requestId?: string; // 请求 ID
    error?: string; // 错误信息
    errorCount?: number; // 错误计数
    startedAt?: Date; // 传输开始时间
    endedAt?: Date; // 传输结束时间
    children?: TransferItem[]; // 子任务
    parent?: TransferItem; // 父任务
    startType: "new" | "resume" | "retry"; // 开始传输类型，new: 新建，resume: 恢复，retry: 重试
    loadingFlag: LoadingFlag; // 正在修改状态的标志，none: 无，start: 开始，stop: 停止，cancel: 取消，retry: 重试
    stop: () => Promise<void>; // 停止传输
    resume: () => Promise<void>; // 恢复传输
    cancel: () => Promise<void>; // 取消传输
    retry: () => Promise<void>; // 重试传输
} & ByteProgressMeta;

export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 16;
const CONCURRENCY_DEFAULT = 5;

/** 错误文本 */
function errText(e: unknown, fallback: string): string {
    if (e instanceof Error) return e.message || fallback;
    if (e && typeof e === "object" && "msg" in e) return String((e as { msg?: string }).msg || fallback);
    if (typeof e === "string") return e;
    return fallback;
}

export const useDownloadStore = defineStore("sftp-download", () => {
    let running = 0;
    let __id_counter = 0;
    const configStore = useConfigStore();

    const concurrency = ref(CONCURRENCY_DEFAULT);
    const taskItems = ref<TransferItem[]>([]);
    const allLoadingFlag = ref<LoadingFlag>("none");

    const taskFileList = computed(() => {
        const list: TransferItem[] = [];
        treeForEach(taskItems.value, (item: TransferItem) => {
            if (item.isDir) return;
            list.push(item);
        });
        return list;
    });

    const totalCount = computed(() => taskFileList.value.filter((it) => it.status !== "cancelled").length);
    const activeCount = computed(() => taskFileList.value.filter((it) => it.status === "running" || it.status === "queued" || it.status === "paused").length);

    const canPauseAll = computed(() => activeCount.value > 0);
    const canResumeAll = computed(() => taskFileList.value.some((it) => it.status === "paused"));
    const canCancelAll = computed(() => activeCount.value > 0);

    /** 后端执行下载并直接写入本地文件 */
    async function sftpDownloadFile(
        requestId: string,
        serverId: string,
        remotePath: string,
        localPath: string,
        offset: number,
        total: number,
        progress: (data: DownloadProgressPayload) => void,
    ): Promise<"Success" | "Paused" | "Cancelled"> {
        const stream = new Channel<DownloadProgressPayload>();
        stream.onmessage = progress;
        return await invoke<"Success" | "Paused" | "Cancelled">("cat_download_file", { stream, requestId, serverId, remotePath, localPath, offset, total });
    }

    /** 后端执行下载并直接写入本地文件 */
    async function sftpUploadFile(
        requestId: string,
        serverId: string,
        remotePath: string,
        localPath: string,
        offset: number,
        total: number,
        progress: (data: DownloadProgressPayload) => void,
    ): Promise<"Success" | "Paused" | "Cancelled"> {
        const stream = new Channel<DownloadProgressPayload>();
        stream.onmessage = progress;
        return await invoke<"Success" | "Paused" | "Cancelled">("upload_file", { stream, requestId, serverId, remotePath, localPath, offset, total });
    }

    /** 暂停后端下载任务 */
    async function sftpTransferPause(requestId: string): Promise<void> {
        await invoke("transfer_pause", { requestId });
    }

    /** 取消后端下载任务 */
    async function sftpTransferCancel(requestId: string): Promise<void> {
        await invoke("transfer_cancel", { requestId });
    }

    function nextId(): number {
        return __id_counter++;
    }

    function parentEdit(item: TransferItem, call: (parent: TransferItem) => void) {
        if (item.parent) {
            call(item.parent);
            parentEdit(item.parent, call);
        }
    }

    function appendBps(item: TransferItem, delta: number): void {
        const bucket = Math.floor(Date.now() / 1000) * 1000;
        item.bps[bucket] = (item.bps[bucket] || 0) + delta;
        const expire = bucket - 15000;
        for (const key of Object.keys(item.bps)) {
            if (Number(key) < expire) delete item.bps[Number(key)];
        }
    }

    async function runItem(item: TransferItem): Promise<void> {
        if (item.kind === "download") {
            await handleDownload(item);
        } else if (item.kind === "upload") {
            await handleUpload(item);
        }
    }

    function runNext() {
        if (running >= concurrency.value) return;
        const nextItem = taskFileList.value.find((it) => it.status === "queued");
        if (nextItem) {
            running += 1;
            // 拿到任务信号后立即修改状态，避免重复运行
            nextItem.status = "running";
            syncParentStatus(nextItem);
            runNext();
            runItem(nextItem).finally(() => {
                running -= 1;
                runNext();
            });
        }
    }

    async function stopItem(item: TransferItem): Promise<void> {
        if (item.requestId) {
            item.loadingFlag = "stop";
            await sftpTransferPause(item.requestId).finally(() => {
                item.loadingFlag = "none";
            });
        } else if (!["cancelled", "error", "success"].includes(item.status)) {
            item.status = "paused";
            syncParentStatus(item);
            return;
        }
    }
    async function resumeItem(item: TransferItem): Promise<void> {
        if (item.loadingFlag !== "none") return;
        if (item.status !== "paused" && item.status !== "error") return;
        item.status = "queued";
        item.startType = "resume";
        runNext();
    }
    async function cancelItem(item: TransferItem): Promise<void> {
        if (item.requestId) {
            await sftpTransferCancel(item.requestId);
        }
        item.status = "cancelled";
        syncParentStatus(item);
        runNext();
    }
    async function retryItem(item: TransferItem): Promise<void> {
        item.status = "queued";
        item.startType = "retry";
        syncParentStatus(item);
        runNext();
    }

    function syncParentStatus(detail: TransferItem): void {
        parentEdit(detail, (parent) => {
            const children = parent.children!;
            parent.errorCount = children.reduce((acc, c) => acc + (c.errorCount ?? 0), 0);
            parent.error = detail.error;
            if (children.some((c) => c.status === "running" || c.status === "queued")) {
                parent.status = "running";
            } else if (children.every((c) => c.status === "paused")) {
                parent.status = "paused";
            } else if (children.every((c) => c.status === "success")) {
                parent.status = "success";
                parent.endedAt = new Date();
            } else if (children.every((c) => c.status === "cancelled")) {
                parent.status = "cancelled";
            } else if (children.some((c) => c.status === "error")) {
                parent.status = "error";
            }
        });
    }

    /** 清理已完成任务 */
    function cleanFinishedTasks(): void {
        taskFileList.value.forEach((item) => {
            if (item.status === "success") {
                item.cancel();
                syncParentStatus(item);
            }
        });
    }

    /** 停止所有任务 */
    function stopAllTasks(): void {
        allLoadingFlag.value = "stop";
        Promise.all(taskFileList.value.map((item) => item.stop())).finally(() => {
            allLoadingFlag.value = "none";
        });
    }

    /** 开始所有任务 */
    function startAllTasks(): void {
        taskFileList.value.forEach((item) => {
            if (item.status === "paused") {
                item.resume();
            }
        });
    }

    /** 取消所有任务 */
    function cancelAllTasks(): void {
        taskFileList.value.forEach((item) => {
            item.cancel();
        });
    }

    async function __transfer(detail: TransferItem, task: Promise<"Success" | "Paused" | "Cancelled">): Promise<void> {
        const { total } = detail;
        detail.bps = {};
        detail.status = "running";
        syncParentStatus(detail);
        const bpsTask = setInterval(() => {
            detail.speedBps = calculateSpeedBps(detail.bps);
            detail.remainingTime = ((total - detail.loaded) / detail.speedBps) * 1000;
            parentEdit(detail, (parent) => {
                parent.speedBps = calculateSpeedBps(parent.bps);
            });
        }, 1000);
        try {
            const status = await task;
            if (status === "Success") {
                parentEdit(detail, (parent) => {
                    parent.loaded += 1;
                });
                detail.status = "success";
                detail.endedAt = new Date();
            } else if (status === "Paused") {
                detail.status = "paused";
            } else if (status === "Cancelled") {
                detail.status = "cancelled";
            }
        } catch (error) {
            detail.errorCount = 1;
            detail.status = "error";
            detail.error = errText(error, "失败");
        } finally {
            clearInterval(bpsTask);
        }
        syncParentStatus(detail);
    }

    // ---------------- 下载事件 ----------------

    /** 检查本地路径是否存在，已经存在就返回新的(1),(2)递增 */
    async function localPathCheck(localPath: string): Promise<string> {
        const par = parentDirSlash(localPath);
        const fileName = baseName(localPath);
        const dotIndex = fileName.lastIndexOf(".");
        const hasExt = dotIndex > 0;
        const base = hasExt ? fileName.slice(0, dotIndex) : fileName;
        const ext = hasExt ? fileName.slice(dotIndex) : "";
        let nextPath = localPath;
        let index = 1;
        while (true) {
            try {
                await stat(nextPath);
                nextPath = `${par}/${base}(${index})${ext}`;
                index += 1;
            } catch {
                return nextPath;
            }
        }
    }

    async function addDownloadTask(ctx: SftpPaneTransferBinding, paths: string[]): Promise<void> {
        for (const path of paths) {
            // 读取远程文件信息
            const item = await scanRemoteTree(ctx.serverId, path);
            const remoteAbsPath = parentDirSlash(path);
            const task = await treeForMap(item, async (item: RemoteFileItem) => {
                const name = baseName(item.id);
                const localRelativePath = item.id.replace(remoteAbsPath, "");
                const localPath = `${configStore.downloadDir}${localRelativePath}`;
                const loaded = (await localFileByteSize(localPath)) || 0;
                const total = item.isDir ? item.children!.length : item.size;
                return {
                    id: nextId(),
                    serverId: ctx.serverId,
                    kind: "download",
                    name,
                    isDir: item.isDir,
                    remotePath: item.linkPath ?? item.id,
                    localPath,
                    speedBps: 0,
                    status: "queued",
                    bps: {},
                    loaded,
                    total,
                    startType: "new",
                    loadingFlag: "none",
                    stop() {
                        return stopItem(this);
                    },
                    resume() {
                        return resumeItem(this);
                    },
                    cancel() {
                        return cancelItem(this);
                    },
                    retry() {
                        return retryItem(this);
                    },
                } as TransferItem;
            });
            treeForEachDeep(task, (item, parent) => {
                item.parent = parent;
            });
            taskItems.value.push(task);
        }
        runNext();
    }

    async function ensureProgressListener(detail: TransferItem, payload: DownloadProgressPayload): Promise<void> {
        detail.loaded = payload.loaded;
        detail.total = payload.total;
        appendBps(detail, payload.delta);
        parentEdit(detail, (parent) => {
            appendBps(parent, payload.delta);
        });
    }

    async function handleDownload(detail: TransferItem): Promise<void> {
        try {
            const { serverId, localPath, remotePath, total, startType } = detail;
            if (total === null) {
                detail.status = "error";
                syncParentStatus(detail);
                throw new Error("文件大小未知");
            }
            const localPathOk = startType === "new" ? await localPathCheck(localPath) : localPath;
            if (startType === "new") {
                await mkdir(parentDirSlash(localPathOk), { recursive: true });
                detail.loaded = 0;
                detail.localPath = localPathOk;
            } else if (startType === "resume") {
                const loaded = (await localFileByteSize(localPathOk)) || 0;
                if (loaded === total) {
                    detail.status = "success";
                    detail.endedAt = new Date();
                    syncParentStatus(detail);
                    return;
                } else if (loaded > total) {
                    // 大小异常了直接重新下载
                    await removeLocalIfAny(localPathOk);
                    detail.loaded = 0;
                } else {
                    detail.loaded = loaded;
                }
            } else if (startType === "retry") {
                await removeLocalIfAny(localPathOk);
                detail.loaded = 0;
            }
            if (detail.status === "cancelled") {
                syncParentStatus(detail);
                return;
            }

            const requestId = uuid();
            detail.requestId = requestId;
            return __transfer(
                detail,
                sftpDownloadFile(requestId, serverId, remotePath, localPathOk, detail.loaded, total, (data) => {
                    ensureProgressListener(detail, data);
                }),
            );
        } catch (error) {
            detail.errorCount = 1;
            detail.status = "error";
            detail.error = errText(error, "下载失败");
        }
        syncParentStatus(detail);
    }

    // ---------------- 上传事件 ----------------

    /** 检查远程路径是否存在，已经存在就返回新的(1),(2)递增 */
    async function remotePathCheck(serverId: string, remotePath: string): Promise<string> {
        const par = parentDirSlash(remotePath);
        const fileName = baseName(remotePath);
        const dotIndex = fileName.lastIndexOf(".");
        const hasExt = dotIndex > 0;
        const base = hasExt ? fileName.slice(0, dotIndex) : fileName;
        const ext = hasExt ? fileName.slice(dotIndex) : "";
        let nextPath = remotePath;
        let index = 1;
        while (await oneFileRemoteItem(serverId, nextPath)) {
            nextPath = `${par}/${base}(${index})${ext}`;
            index += 1;
        }
        return nextPath;
    }

    /** 添加上传任务
     * @param ctx 上下文
     * @param localPaths 本地路径
     * @param remoteDir 远程目录
     * @param callback 回调函数 没完成一个文件就会回调一次 参数为传输成功的文件的本地路径
     */
    async function addUploadTask(ctx: SftpPaneTransferBinding, localPaths: string[], remoteDir: string, callback?: (path: string) => void): Promise<void> {
        const conflictList: TransferItem[] = [];
        async function addPath(localPath: string, localAbsPath?: string): Promise<TransferItem | null> {
            const localInfo = await stat(localPath);
            const name = await basename(localPath);
            const parentDir = await dirname(localPath);
            let remotePath = "";
            if (localAbsPath) {
                const relativePath = localPath.replace(localAbsPath, "");
                remotePath = await remoteJoin(remoteDir, relativePath);
            } else {
                remotePath = await remoteJoin(remoteDir, name);
            }
            const item: TransferItem = {
                id: nextId(),
                serverId: ctx.serverId,
                kind: "upload",
                name,
                isDir: localInfo.isDirectory,
                remotePath: remotePath,
                localPath,
                speedBps: 0,
                status: "queued",
                bps: {},
                loaded: 0,
                total: localInfo.isDirectory ? 0 : localInfo.size,
                startType: "new",
                loadingFlag: "none",
                stop() {
                    return stopItem(this);
                },
                resume() {
                    return resumeItem(this);
                },
                cancel() {
                    return cancelItem(this);
                },
                retry() {
                    return retryItem(this);
                },
            };
            if (localInfo.isDirectory) {
                const children = await readDir(localPath);
                const taskChildren: TransferItem[] = [];
                for (const child of children) {
                    const childTask = await addPath(await join(localPath, child.name), localAbsPath ?? parentDir);
                    if (!childTask) continue;
                    taskChildren.push(childTask);
                }
                item.children = taskChildren;
                item.total = taskChildren.reduce((acc, child) => acc + (child.isDir ? child.total! : 1), 0);
            } else if (name === ".DS_Store") {
                return null;
            } else {
                const file = await oneFileRemoteItem(ctx.serverId, remotePath);
                if (file) {
                    conflictList.push(item);
                }
            }
            return item;
        }
        const list: TransferItem[] = [];
        for (const path of localPaths) {
            const task = await addPath(path);
            if (!task) continue;
            treeForEachDeep(task, (item, parent) => {
                item.parent = parent;
            });
            list.push(task);
        }
        let applyConflictAction: UploadConflictAction | null = null;
        const winId = uuid();
        for (let i = 0; i < conflictList.length; i++) {
            const item = conflictList[i];
            let action: UploadConflictAction | null = null;
            if (applyConflictAction) {
                action = applyConflictAction;
            } else {
                const { action: _action, applyToAll } = await openUploadConflictWindow({
                    winId,
                    taskId: item.id.toString(),
                    fileName: item.name,
                    localPath: item.localPath,
                    remotePath: item.remotePath,
                    last: i === conflictList.length - 1, // 最后一个文件是最后一个窗口
                });
                action = _action;
                if (applyToAll) {
                    applyConflictAction = action;
                }
            }
            if (action === "cancel") return;
            if (action === "skip") {
                item.status = "cancelled";
            } else if (action === "copy") {
                item.remotePath = `${item.remotePath} Copy`;
            } else {
                // 默认处理就是覆盖
            }
        }
        taskItems.value.push(...list);
        runNext();
    }

    async function handleUpload(detail: TransferItem): Promise<void> {
        const { serverId, localPath, remotePath, total, startType } = detail;
        try {
            if (detail.isDir) {
                await execRemote(serverId, `mkdir -p ${shellSingleQuote(remotePath)}`);
                detail.status = "success";
                detail.endedAt = new Date();
                syncParentStatus(detail);
                return;
            }
            if (startType === "new") {
                const dir = parentDirSlash(remotePath);
                await execRemote(serverId, `mkdir -p ${shellSingleQuote(dir)}`);
                await remoteRemove(serverId, remotePath);
            } else if (startType === "resume") {
                const file = await oneFileRemoteItem(serverId, remotePath);
                const loaded = file?.size ?? 0;
                if (loaded === total) {
                    detail.status = "success";
                    detail.endedAt = new Date();
                    syncParentStatus(detail);
                    return;
                } else if (loaded > total) {
                    await remoteRemove(serverId, remotePath);
                    detail.loaded = 0;
                } else {
                    detail.loaded = loaded;
                }
            } else if (startType === "retry") {
                await remoteRemove(serverId, remotePath);
                detail.loaded = 0;
            }
            if (detail.status === "cancelled") {
                syncParentStatus(detail);
                return;
            }
            const requestId = uuid();
            detail.requestId = requestId;
            return __transfer(
                detail,
                sftpUploadFile(requestId, serverId, remotePath, localPath, detail.loaded, total, (data) => {
                    ensureProgressListener(detail, data);
                }),
            );
        } catch (error) {
            detail.errorCount = 1;
            detail.status = "error";
            detail.error = errText(error, "上传失败");
        }
        syncParentStatus(detail);
    }

    return {
        taskItems,
        concurrency,
        addDownloadTask,
        totalCount,
        activeCount,
        canPauseAll,
        canResumeAll,
        canCancelAll,
        allLoadingFlag,
        stopAllTasks,
        startAllTasks,
        cancelAllTasks,
        cleanFinishedTasks,
        addUploadTask,
    };
});

export type DownloadStore = ReturnType<typeof useDownloadStore>;
