import { Channel } from "@tauri-apps/api/core";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { mkdir, readDir, stat } from "@tauri-apps/plugin-fs";
import { create } from "zustand";
import { calculateSpeedBps, treeForEach, treeForEachDeep, treeForMap, uuid } from "@/utils";
import { baseName, oneFileRemoteItem, parentDirSlash, remoteJoin, remoteRemove, scanRemoteTree, type RemoteFileItem } from "@/utils/fsUtil";
import { localFileByteSize, localPathToLinuxPath, removeLocalIfAny } from "@/utils/localFsUtils";
import { execRemote, invoke, shellSingleQuote } from "@/utils/project";
import { useConfigStore } from "@/stores/config";
import { openUploadConflictWindow, type UploadConflictAction } from "@/utils/window";

export type TransferStatus = "queued" | "running" | "paused" | "cancelled" | "success" | "error";
export type TransferKind = "upload" | "download";

/** 各终端 SFTP 面板注册后，传输完成/删文件时可刷新对应文件树与错误条 */
export type SftpPaneTransferBinding = {
    sessionId: string; // 终端 sessionID
    serverId: string; // 服务器存储的id
};

/** 文件字节信息 */
export type ByteProgressMeta = { loaded: number; total: number | null };
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
    endCall: () => void;
} & ByteProgressMeta;

export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 16;
const CONCURRENCY_DEFAULT = 5;

function errText(e: unknown, fallback: string): string {
    if (e instanceof Error) return e.message || fallback;
    if (e && typeof e === "object" && "msg" in e) return String((e as { msg?: string }).msg || fallback);
    if (typeof e === "string") return e;
    return fallback;
}

type DownloadStoreState = {
    taskItems: TransferItem[];
    concurrency: number;
    totalCount: number;
    activeCount: number;
    canPauseAll: boolean;
    canResumeAll: boolean;
    canCancelAll: boolean;
    allLoadingFlag: LoadingFlag;
    setConcurrency: (value: number) => void;
    addDownloadTask: (ctx: SftpPaneTransferBinding, paths: string[]) => Promise<void>;
    addUploadTask: (ctx: SftpPaneTransferBinding, localPaths: string[], remoteDir: string, callback?: (item: TransferItem) => void) => Promise<void>;
    stopAllTasks: () => void;
    startAllTasks: () => void;
    cancelAllTasks: () => void;
    cleanFinishedTasks: () => void;
};

let running = 0;
let idCounter = 0;

function taskFileList(taskItems: TransferItem[]): TransferItem[] {
    const list: TransferItem[] = [];
    treeForEach(taskItems, (item: TransferItem) => {
        if (item.isDir) return;
        list.push(item);
    });
    return list;
}

function derive(items: TransferItem[]) {
    const files = taskFileList(items);
    const totalCount = files.filter((it) => it.status !== "cancelled").length;
    const activeCount = files.filter((it) => it.status === "running" || it.status === "queued" || it.status === "paused").length;
    return {
        totalCount,
        activeCount,
        canPauseAll: activeCount > 0,
        canResumeAll: files.some((it) => it.status === "paused"),
        canCancelAll: activeCount > 0,
    };
}

export const useDownloadStore = create<DownloadStoreState>((set, get) => {
    function sync() {
        const taskItems = [...get().taskItems];
        set({ taskItems, ...derive(taskItems) });
    }

    async function sftpDownloadFile(requestId: string, serverId: string, remotePath: string, localPath: string, offset: number, total: number, progress: (data: DownloadProgressPayload) => void) {
        const stream = new Channel<DownloadProgressPayload>();
        stream.onmessage = progress;
        return await invoke<"Success" | "Paused" | "Cancelled">("cat_download_file", { stream, requestId, serverId, remotePath, localPath, offset, total });
    }

    async function sftpUploadFile(requestId: string, serverId: string, remotePath: string, localPath: string, offset: number, total: number, progress: (data: DownloadProgressPayload) => void) {
        const stream = new Channel<DownloadProgressPayload>();
        stream.onmessage = progress;
        return await invoke<"Success" | "Paused" | "Cancelled">("upload_file", { stream, requestId, serverId, remotePath, localPath, offset, total });
    }

    async function sftpTransferPause(requestId: string): Promise<void> {
        await invoke("transfer_pause", { requestId });
    }

    async function sftpTransferCancel(requestId: string): Promise<void> {
        await invoke("transfer_cancel", { requestId });
    }

    function nextId(): number {
        return idCounter++;
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

    function syncParentStatus(detail: TransferItem): void {
        parentEdit(detail, (parent) => {
            const children = parent.children!;
            parent.errorCount = children.reduce((acc, c) => acc + (c.errorCount ?? 0), 0);
            parent.error = detail.error;
            if (children.some((c) => c.status === "running" || c.status === "queued")) parent.status = "running";
            else if (children.every((c) => c.status === "paused")) parent.status = "paused";
            else if (children.every((c) => c.status === "success")) {
                parent.status = "success";
                parent.endedAt = new Date();
            } else if (children.every((c) => c.status === "cancelled")) parent.status = "cancelled";
            else if (children.some((c) => c.status === "error")) parent.status = "error";
        });
        sync();
    }

    function runNext() {
        if (running >= get().concurrency) return;
        const nextItem = taskFileList(get().taskItems).find((it) => it.status === "queued");
        if (!nextItem) return;
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

    async function stopItem(item: TransferItem): Promise<void> {
        if (item.requestId) {
            item.loadingFlag = "stop";
            sync();
            await sftpTransferPause(item.requestId).finally(() => {
                item.loadingFlag = "none";
                sync();
            });
        } else if (!["cancelled", "error", "success"].includes(item.status)) {
            item.status = "paused";
            syncParentStatus(item);
        }
    }

    async function resumeItem(item: TransferItem): Promise<void> {
        if (item.loadingFlag !== "none") return;
        if (item.status !== "paused" && item.status !== "error") return;
        item.status = "queued";
        item.startType = "resume";
        sync();
        runNext();
    }

    async function cancelItem(item: TransferItem): Promise<void> {
        if (item.requestId) await sftpTransferCancel(item.requestId);
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

    async function transfer(detail: TransferItem, task: Promise<"Success" | "Paused" | "Cancelled">): Promise<void> {
        const { total } = detail;
        detail.bps = {};
        detail.status = "running";
        syncParentStatus(detail);
        const bpsTask = window.setInterval(() => {
            detail.speedBps = calculateSpeedBps(detail.bps);
            const safeTotal = total ?? 0;
            detail.remainingTime = ((safeTotal - detail.loaded) / detail.speedBps) * 1000;
            parentEdit(detail, (parent) => {
                parent.speedBps = calculateSpeedBps(parent.bps);
            });
            sync();
        }, 1000);
        try {
            const status = await task;
            if (status === "Success") {
                parentEdit(detail, (parent) => {
                    parent.loaded += 1;
                });
                detail.status = "success";
                detail.endedAt = new Date();
            } else if (status === "Paused") detail.status = "paused";
            else if (status === "Cancelled") detail.status = "cancelled";
        } catch (error) {
            detail.errorCount = 1;
            detail.status = "error";
            detail.error = errText(error, "失败");
        } finally {
            window.clearInterval(bpsTask);
            detail.requestId = undefined;
        }
        syncParentStatus(detail);
    }

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

    async function handleDownload(detail: TransferItem): Promise<void> {
        try {
            const { serverId, localPath, remotePath, total, startType } = detail;
            if (total === null) throw new Error("文件大小未知");
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
                }
                if (loaded > total) {
                    await removeLocalIfAny(localPathOk);
                    detail.loaded = 0;
                } else {
                    detail.loaded = loaded;
                }
            } else if (startType === "retry") {
                await removeLocalIfAny(localPathOk);
                detail.loaded = 0;
            }
            if (detail.status === "cancelled") return;
            const requestId = uuid();
            detail.requestId = requestId;
            await transfer(
                detail,
                sftpDownloadFile(requestId, serverId, remotePath, localPathOk, detail.loaded, total, (data) => {
                    detail.loaded = data.loaded;
                    detail.total = data.total;
                    appendBps(detail, data.delta);
                    parentEdit(detail, (parent) => appendBps(parent, data.delta));
                    sync();
                }),
            );
        } catch (error) {
            detail.errorCount = 1;
            detail.status = "error";
            detail.error = errText(error, "下载失败");
        }
        syncParentStatus(detail);
    }

    async function handleUpload(detail: TransferItem): Promise<void> {
        try {
            const { serverId, localPath, remotePath, total, startType } = detail;
            if (detail.isDir) {
                await execRemote(serverId, `mkdir -p ${shellSingleQuote(remotePath)}`);
                detail.status = "success";
                detail.endedAt = new Date();
                syncParentStatus(detail);
                return;
            }
            if (total === null) throw new Error("文件大小未知");
            if (startType === "new") {
                await execRemote(serverId, `mkdir -p ${shellSingleQuote(parentDirSlash(remotePath))}`);
                await remoteRemove(serverId, remotePath);
            } else if (startType === "resume") {
                const file = await oneFileRemoteItem(serverId, remotePath);
                const loaded = file?.size ?? 0;
                if (loaded === total) {
                    detail.status = "success";
                    detail.endedAt = new Date();
                    syncParentStatus(detail);
                    return;
                }
                if (loaded > total) {
                    await remoteRemove(serverId, remotePath);
                    detail.loaded = 0;
                } else detail.loaded = loaded;
            } else if (startType === "retry") {
                await remoteRemove(serverId, remotePath);
                detail.loaded = 0;
            }
            if (detail.status === "cancelled") return;
            const requestId = uuid();
            detail.requestId = requestId;
            await transfer(
                detail,
                sftpUploadFile(requestId, serverId, remotePath, localPath, detail.loaded, total, (data) => {
                    detail.loaded = data.loaded;
                    detail.total = data.total;
                    appendBps(detail, data.delta);
                    parentEdit(detail, (parent) => appendBps(parent, data.delta));
                    sync();
                }),
            );
        } catch (error) {
            detail.errorCount = 1;
            detail.status = "error";
            detail.error = errText(error, "上传失败");
        }
        detail.endCall();
        syncParentStatus(detail);
    }

    async function runItem(item: TransferItem): Promise<void> {
        if (item.kind === "download") await handleDownload(item);
        else await handleUpload(item);
    }

    function createTaskBase(input: Omit<TransferItem, "stop" | "resume" | "cancel" | "retry" | "endCall">, endCall?: (item: TransferItem) => void): TransferItem {
        const task: TransferItem = {
            ...input,
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
            endCall() {
                endCall?.(task);
            },
        };
        return task;
    }

    return {
        taskItems: [],
        concurrency: CONCURRENCY_DEFAULT,
        ...derive([]),
        allLoadingFlag: "none",
        setConcurrency(value) {
            set({ concurrency: Math.max(CONCURRENCY_MIN, Math.min(CONCURRENCY_MAX, Math.trunc(value))) });
            // 并行数调高后立即尝试消化队列，调低时当前任务自然结束后收敛。
            runNext();
        },
        async addDownloadTask(ctx, paths) {
            for (const path of paths) {
                const item = await scanRemoteTree(ctx.serverId, path);
                const remoteAbsPath = parentDirSlash(path);
                const task = await treeForMap(item, async (remoteItem: RemoteFileItem) => {
                    const name = baseName(remoteItem.id);
                    const localRelativePath = remoteItem.id.replace(remoteAbsPath, "");
                    const localPath = `${useConfigStore.getState().downloadDir}${localRelativePath}`;
                    const loaded = (await localFileByteSize(localPath)) || 0;
                    const total = remoteItem.isDir ? remoteItem.children!.length : remoteItem.size;
                    return createTaskBase({
                        id: nextId(),
                        serverId: ctx.serverId,
                        kind: "download",
                        name,
                        isDir: remoteItem.isDir,
                        remotePath: remoteItem.linkPath ?? remoteItem.id,
                        localPath,
                        speedBps: 0,
                        status: "queued",
                        bps: {},
                        loaded,
                        total,
                        startType: "new",
                        loadingFlag: "none",
                    });
                });
                treeForEachDeep(task, (transferItem, parent) => {
                    transferItem.parent = parent;
                    if (transferItem.isDir) transferItem.total = transferItem.children!.reduce((acc, child) => acc + (child.isDir ? (child.total ?? 0) : 1), 0);
                });
                get().taskItems.push(task);
            }
            sync();
            runNext();
        },
        async addUploadTask(ctx, localPaths, remoteDir, callback) {
            const conflictList: TransferItem[] = [];
            async function addPath(localPath: string, localAbsPath?: string): Promise<TransferItem | null> {
                const localInfo = await stat(localPath);
                const name = await basename(localPath);
                let remotePath = "";
                if (localAbsPath) {
                    const relativePath = localPath.replace(localAbsPath, "");
                    const linuxRelativePath = localPathToLinuxPath(relativePath).slice(1);
                    remotePath = await remoteJoin(remoteDir, linuxRelativePath);
                } else {
                    remotePath = await remoteJoin(remoteDir, name);
                }
                const item = createTaskBase(
                    {
                        id: nextId(),
                        serverId: ctx.serverId,
                        kind: "upload",
                        name,
                        isDir: localInfo.isDirectory,
                        remotePath,
                        localPath,
                        speedBps: 0,
                        status: "queued",
                        bps: {},
                        loaded: 0,
                        total: localInfo.isDirectory ? 0 : localInfo.size,
                        startType: "new",
                        loadingFlag: "none",
                    },
                    (task) => callback?.(task),
                );
                if (localInfo.isDirectory) {
                    const children = await readDir(localPath);
                    const taskChildren: TransferItem[] = [];
                    for (const child of children) {
                        const childTask = await addPath(await join(localPath, child.name), localAbsPath ?? (await dirname(localPath)));
                        if (childTask) taskChildren.push(childTask);
                    }
                    item.children = taskChildren;
                    item.total = taskChildren.reduce((acc, child) => acc + (child.isDir ? (child.total ?? 0) : 1), 0);
                } else if (name === ".DS_Store") {
                    return null;
                } else if (await oneFileRemoteItem(ctx.serverId, remotePath)) {
                    conflictList.push(item);
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
                let action: UploadConflictAction | null = applyConflictAction;
                if (!action) {
                    const resolved = await openUploadConflictWindow({
                        winId,
                        taskId: item.id.toString(),
                        fileName: item.name,
                        localPath: item.localPath,
                        remotePath: item.remotePath,
                        last: i === conflictList.length - 1,
                    });
                    action = resolved.action;
                    if (resolved.applyToAll) applyConflictAction = action;
                }
                if (action === "cancel") return;
                if (action === "skip") item.status = "cancelled";
                else if (action === "copy") item.remotePath = `${item.remotePath} Copy`;
            }
            get().taskItems.push(...list);
            sync();
            runNext();
        },
        stopAllTasks() {
            set({ allLoadingFlag: "stop" });
            Promise.all(taskFileList(get().taskItems).map((item) => item.stop())).finally(() => set({ allLoadingFlag: "none" }));
        },
        startAllTasks() {
            taskFileList(get().taskItems).forEach((item) => {
                if (item.status === "paused") void item.resume();
            });
        },
        cancelAllTasks() {
            taskFileList(get().taskItems).forEach((item) => {
                void item.cancel();
            });
        },
        cleanFinishedTasks() {
            taskFileList(get().taskItems).forEach((item) => {
                if (item.status === "success") {
                    void item.cancel();
                    syncParentStatus(item);
                }
            });
        },
    };
});

export type DownloadStore = typeof useDownloadStore;
