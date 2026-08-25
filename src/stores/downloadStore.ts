import { computed, ref } from "vue";
import { acceptHMRUpdate, defineStore } from "pinia";
import { mkdir, readDir, stat } from "@tauri-apps/plugin-fs";
import { parentDirSlash, remoteJoin, remoteRemove } from "@/utils/fsUtil";
import { treeForMap, uuid } from "@/utils";
import { useConfigStore } from "./config";
import { basename, dirname, join } from "@tauri-apps/api/path";
import { Channel } from "@tauri-apps/api/core";
import { openUploadConflictWindow, type UploadConflictAction } from "@/utils/window";

export type TransferStatus = "queued" | "running" | "paused" | "cancelled" | "success" | "error";
export type TransferKind = "upload" | "download";
export type SetStatusFrom = "task" | "parent" | "child" | "resume" | "retry" | "action";

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
    loadingFlag: LoadingFlag; // 正在修改状态的标志，none: 无，stop: 停止
    stop: () => Promise<void>; // 停止传输
    resume: () => Promise<void>; // 恢复传输
    cancel: () => Promise<void>; // 取消传输
    retry: () => Promise<void>; // 重试传输
    changeCall: () => void;
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
    const channelInstancesStore = useChannelInstancesStore();

    const concurrency = ref(CONCURRENCY_DEFAULT);
    const taskItems = ref<TransferItem[]>([]);
    const allLoadingFlag = ref<LoadingFlag>("none");
    const generateLoading = ref<boolean>(false);

    const taskFileList = computed(() => {
        const list: TransferItem[] = [];
        treeForEach(taskItems.value, (item: TransferItem) => {
            if (item.isDir) return;
            list.push(item);
        });
        return list;
    });

    const totalCount = computed(() => taskFileList.value.filter((it) => it.status !== "cancelled").length);
    const activeCount = computed(
        () => taskFileList.value.filter((it) => it.status === "running" || it.status === "queued" || it.status === "paused").length,
    );

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
        return await invoke<"Success" | "Paused" | "Cancelled">("cat_download_file", {
            stream,
            requestId,
            serverId,
            remotePath,
            localPath,
            offset,
            total,
        });
    }

    /** 后端执行下载并直接写入本地文件 */
    async function sftpUploadFile(
        requestId: string,
        serverId: string,
        remotePath: string,
        localPath: string,
        offset: number,
        total: number,
        bufSize: number,
        progress: (data: DownloadProgressPayload) => void,
    ): Promise<"Success" | "Paused" | "Cancelled"> {
        const stream = new Channel<DownloadProgressPayload>();
        stream.onmessage = progress;
        return await invoke<"Success" | "Paused" | "Cancelled">("upload_file", {
            stream,
            requestId,
            serverId,
            remotePath,
            localPath,
            offset,
            total,
            bufSize,
        });
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

    async function runNext() {
        if (running >= concurrency.value) return;
        const nextItem = taskFileList.value.find((it) => it.status === "queued");
        if (nextItem) {
            running += 1;
            // 拿到任务信号后立即修改状态，避免重复运行
            await statusMachine(nextItem, "running", "task");
            runNext();
            runItem(nextItem);
        }
    }

    /** 清理已完成任务 */
    async function cleanFinishedTasks(): Promise<void> {
        for (const item of taskFileList.value) {
            if (item.status === "success") {
                await statusMachine(item, "cancelled", "action");
            }
        }
    }

    /** 停止所有任务 */
    async function stopAllTasks(): Promise<void> {
        allLoadingFlag.value = "stop";
        try {
            for (const item of taskFileList.value) {
                await statusMachine(item, "paused", "action");
            }
        } finally {
            allLoadingFlag.value = "none";
        }
    }

    /** 开始所有任务：paused → queued 只允许 resume，不能走 action */
    async function startAllTasks(): Promise<void> {
        for (const item of taskFileList.value) {
            if (item.status === "paused") {
                await statusMachine(item, "queued", "resume");
            }
        }
    }

    /** 取消所有任务 */
    async function cancelAllTasks(): Promise<void> {
        for (const item of taskFileList.value) {
            await statusMachine(item, "cancelled", "action");
        }
    }

    async function __transfer(detail: TransferItem, task: Promise<"Success" | "Paused" | "Cancelled">): Promise<void> {
        const { total } = detail;
        detail.bps = {};
        const bpsTask = setInterval(() => {
            detail.speedBps = calculateSpeedBps(detail.bps);
            // 计算时间时必须避免除以0
            detail.remainingTime = ((total - detail.loaded) / (detail.speedBps || 1)) * 1000;
            parentEdit(detail, (parent) => {
                parent.speedBps = calculateSpeedBps(parent.bps);
            });
        }, 1000);
        try {
            // 从提交任务到这里执行前修改过状态，直接返回
            if (detail.status !== "running") {
                await sftpTransferCancel(detail.requestId!);
                return;
            }
            const resultStatus = await task;
            if (resultStatus === "Success") {
                await statusMachine(detail, "success", "task");
            } else if (resultStatus === "Paused") {
                await statusMachine(detail, "paused", "task");
            } else if (resultStatus === "Cancelled") {
                await statusMachine(detail, "cancelled", "task");
            }
        } catch (error) {
            detail.errorCount = 1;
            detail.error = errText(error, "失败");
            await statusMachine(detail, "error", "task");
        } finally {
            clearInterval(bpsTask);
            detail.requestId = undefined;
        }
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
        generateLoading.value = true;
        try {
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
                        async stop() {
                            await statusMachine(this, "paused", "action");
                        },
                        async resume() {
                            await statusMachine(this, "queued", "resume");
                        },
                        async cancel() {
                            await statusMachine(this, "cancelled", "action");
                        },
                        async retry() {
                            await statusMachine(this, "queued", "retry");
                        },
                    } as TransferItem;
                });
                treeForEachDeep(task, (item, parent) => {
                    item.parent = parent;
                    if (item.isDir) {
                        item.total = item.children!.reduce((acc, child) => acc + (child.isDir ? child.total! : 1), 0);
                    }
                });
                taskItems.value.push(task);
            }
        } finally {
            generateLoading.value = false;
            runNext();
        }
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
                await statusMachine(detail, "error", "task");
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
                    await statusMachine(detail, "success", "task");
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
            if (detail.status !== "running") return;
            const requestId = uuid();
            detail.requestId = requestId;
            await __transfer(
                detail,
                sftpDownloadFile(requestId, serverId, remotePath, localPathOk, detail.loaded, total, (data) => {
                    ensureProgressListener(detail, data);
                }),
            );
        } catch (error) {
            detail.errorCount = 1;
            detail.error = errText(error, "下载失败");
            await statusMachine(detail, "error", "task");
        }
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
        while (await execRemote(serverId, `test -e ${shellSingleQuote(nextPath)} && echo 1`)) {
            nextPath = `${par}/${base}(${index})${ext}`;
            index += 1;
            console.log("nextPath", nextPath);
        }
        return nextPath;
    }

    /** 添加上传任务
     * @param ctx 上下文
     * @param localPaths 本地路径
     * @param remoteDir 远程目录
     * @param callback 回调函数 每完成一个文件就会回调一次 参数为传输任务
     */
    async function addUploadTask(
        ctx: SftpPaneTransferBinding,
        localPaths: string[],
        remoteDir: string,
        callback?: (item: TransferItem) => void,
    ): Promise<void> {
        generateLoading.value = true;
        try {
            const conflictList: TransferItem[] = [];
            async function addPath(localPath: string, localAbsPath?: string): Promise<TransferItem | null> {
                const localInfo = await stat(localPath);
                const name = await basename(localPath);
                let remotePath = "";
                if (localAbsPath) {
                    const relativePath = localPath.replace(localAbsPath, ""); // 获取本地的相对路径
                    const linuxRelativePath = localPathToLinuxPath(relativePath).slice(1); // 将本地的相对路径转成linux路径并删除前面的/
                    remotePath = await remoteJoin(remoteDir, linuxRelativePath);
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
                    async stop() {
                        await statusMachine(this, "paused", "action");
                    },
                    async resume() {
                        await statusMachine(this, "queued", "resume");
                    },
                    async cancel() {
                        await statusMachine(this, "cancelled", "action");
                    },
                    async retry() {
                        await statusMachine(this, "queued", "retry");
                    },
                    changeCall() {
                        callback?.(this);
                    },
                };
                if (localInfo.isDirectory) {
                    const children = await readDir(localPath);
                    const taskChildren: TransferItem[] = [];
                    for (const child of children) {
                        const childTask = await addPath(await join(localPath, child.name), localAbsPath ?? (await dirname(localPath)));
                        if (!childTask) continue;
                        taskChildren.push(childTask);
                    }
                    item.children = taskChildren;
                    item.total = taskChildren.reduce((acc, child) => acc + (child.isDir ? child.total! : 1), 0);
                    // 空目录排除掉
                    if (item.total === 0) return null;
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
                // 空目录排除掉
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
                    await statusMachine(item, "cancelled", "action");
                } else if (action === "copy") {
                    item.remotePath = await remotePathCheck(item.serverId, item.remotePath);
                } else {
                    // 默认处理就是覆盖
                }
            }
            taskItems.value.push(...list);
        } finally {
            generateLoading.value = false;
            runNext();
        }
    }

    async function handleUpload(detail: TransferItem): Promise<void> {
        const { serverId, localPath, remotePath, total, startType } = detail;
        try {
            if (detail.isDir) {
                await execRemote(serverId, `mkdir -p ${shellSingleQuote(remotePath)}`);
                await statusMachine(detail, "success", "task");
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
                    await statusMachine(detail, "success", "task");
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

            let bufSize = 10 * 1024 * 1024; // 默认本地每次读取10MB
            // 更具服务器的CPU，内存尺寸动态设置bufSize
            const instance = channelInstancesStore.instances.find((instance) => {
                if (isChannelInstance(instance)) {
                    return instance.server.id === serverId;
                }
                return false;
            });
            if (instance) {
                const overview = (instance as ChannelInstance).overview;
                const cpu = overview?.cpuTotal || 0;
                const memory_mb = (overview?.mem.totalKb || 0) / 1024;
                if (cpu < 1 || memory_mb < 200)
                    bufSize = 200 * 1024; // 如果服务器CPU小于1核，或者内存小于200MB，则设置bufSize为200KB
                else if (cpu < 2 || memory_mb < 500)
                    bufSize = 500 * 1024; // 如果服务器CPU小于2核，或者内存小于500MB，则设置bufSize为500KB
                else if (cpu < 4 || memory_mb < 1000)
                    bufSize = 800 * 1024; // 如果服务器CPU小于2核，或者内存小于1000MB，则设置bufSize为800KB
                else if (cpu < 8 || memory_mb < 2000)
                    bufSize = 1024 * 1024; // 如果服务器CPU小于4核，或者内存小于2000MB，则设置bufSize为1MB
                else if (cpu < 16 || memory_mb < 4000) bufSize = 5 * 1024 * 1024; // 如果服务器CPU小于8核，或者内存小于4000MB，则设置bufSize为2MB
            }
            if (detail.status !== "running") return;
            const requestId = uuid();
            detail.requestId = requestId;
            let changeCallSc = 0;
            await __transfer(
                detail,
                sftpUploadFile(requestId, serverId, remotePath, localPath, detail.loaded, total, bufSize, (data) => {
                    ensureProgressListener(detail, data);
                    const _changeCallSc = Math.floor(Date.now() / 1000);
                    if (_changeCallSc !== changeCallSc) {
                        detail.changeCall();
                        changeCallSc = _changeCallSc;
                    }
                }),
            );
        } catch (error) {
            detail.errorCount = 1;
            detail.error = errText(error, "上传失败");
            await statusMachine(detail, "error", "task");
        }
        detail.changeCall();
    }

    /**
     * 任务状态机
     * 状态：
     * queued: 排队中
     * running: 运行中
     * paused: 暂停
     * cancelled: 取消
     * success: 成功
     * error: 错误
     * 来源：
     * task: 任务
     * parent: 父任务
     * 修改状态的来源：
     * task: 任务本身
     * parent: 父任务
     * child: 子任务
     * resume: 恢复
     * retry: 重试
     * action: 手动操作
     *
     * loadingFlag: none: 无，start: 开始，stop: 停止，cancel: 取消，retry: 重试
     *
     * 所有状态都允许  自己到自己  的修改
     * */
    async function statusMachine(item: TransferItem, status: TransferStatus, from: SetStatusFrom): Promise<TransferStatus> {
        if (item.isDir) {
            return dirStatusMachine(item, status, from);
        } else {
            return fileStatusMachine(item, status, from);
        }
    }

    type StatusFromRule = Partial<Record<TransferStatus | "*", readonly SetStatusFrom[]>>;
    type StatusRules = Record<TransferStatus, StatusFromRule>;

    /**
     * 转移表：目标状态 -> 现有状态 -> 允许的 from。`*` 表示任意现有状态。
     * queued→paused：注释未列，但暂停排队中的任务 / 文件夹 / 全部暂停需要。
     * error from child：注释只写了 task，子任务失败后文件夹否则会卡在 running。
     */
    const DIR_STATUS_RULES: StatusRules = {
        queued: { error: ["retry", "child", "parent"], paused: ["resume", "child", "parent"] },
        running: { queued: ["child"] },
        paused: { running: ["action", "child", "parent"], queued: ["action", "child", "parent"] },
        cancelled: { "*": ["action", "child", "parent"] },
        success: { running: ["child"] },
        error: { running: ["child"] },
    };

    /**
     * paused/cancelled 额外允许 task：__transfer 会把后端的 Paused/Cancelled 回写为 from=task。
     * queued→paused：同上，暂停尚未开工的文件。
     */
    const FILE_STATUS_RULES: StatusRules = {
        queued: { error: ["retry", "parent"], paused: ["resume", "parent"] },
        running: { queued: ["task"] },
        paused: { running: ["action", "parent", "task"], queued: ["action", "parent"] },
        cancelled: { "*": ["action", "parent", "task"] },
        success: { running: ["task"] },
        error: { running: ["task"] },
    };

    function canTransit(rules: StatusRules, current: TransferStatus, target: TransferStatus, from: SetStatusFrom): boolean {
        if (current === target) return true;
        const rule = rules[target];
        if (rule["*"]?.includes(from)) return true;
        return rule[current]?.includes(from) ?? false;
    }

    /** 恢复/重试进入 queued 时带上 startType；父任务下发时沿用父节点的类型 */
    function applyQueuedStartType(item: TransferItem, from: SetStatusFrom): void {
        if (from === "resume") {
            item.startType = "resume";
            return;
        }
        if (from === "retry") {
            item.startType = "retry";
            item.error = "";
            item.errorCount = 0;
            return;
        }
        if (from === "parent" && item.parent) {
            item.startType = item.parent.startType;
            if (item.startType === "retry") {
                item.error = "";
                item.errorCount = 0;
            }
        }
    }

    function syncDirMeta(item: TransferItem): void {
        const children = item.children ?? [];
        item.errorCount = children.reduce((acc, c) => acc + (c.errorCount ?? 0), 0);
        const errChild = children.find((c) => c.status === "error");
        item.error = errChild?.error ?? "";
        const loaded = children.reduce((acc, c) => {
            if (c.isDir) {
                return acc + (c.loaded ?? 0);
            }
            return acc + (c.status === "success" ? 1 : 0);
        }, 0);
        item.loaded = loaded;
    }

    /**
     * 按子任务汇总文件夹状态。
     * 仍有 queued 且当前已是 running 时，running→queued 非法，状态机会保持 running。
     */
    function deriveDirStatus(item: TransferItem): TransferStatus | undefined {
        const children = item.children ?? [];
        if (!children.length) return undefined;
        const statuses = children.map((c) => c.status);
        const every = (s: TransferStatus) => statuses.every((x) => x === s);
        const some = (s: TransferStatus) => statuses.some((x) => x === s);

        if (some("running")) return "running";
        if (some("queued")) return "queued";
        if (every("success")) return "success";
        if (every("cancelled")) return "cancelled";
        if (every("paused")) return "paused";
        if (every("error")) return "error";
        if (statuses.every((s) => s === "success" || s === "cancelled") && some("success")) return "success";
        if (some("error")) return "error";
        if (some("paused")) return "paused";
        return undefined;
    }

    /**
     * 文件夹任务状态机：
     * 目标状态： 现有状态[操作类型]
     * queued：error[retry|child|parent], paused[resume|child|parent],
     * running: queued[child]
     * paused: running[action|child|parent], queued[action|child|parent]
     * cancelled: *[action|child|parent],
     * success: running[child]
     * error: running[child]
     *
     */
    async function dirStatusMachine(item: TransferItem, status: TransferStatus, from: SetStatusFrom): Promise<TransferStatus> {
        if (from === "child") {
            // child状态改变时，上级只需要重新计算状态
            syncDirMeta(item);
            const derived = deriveDirStatus(item);
            if (!derived) return item.status;
            status = derived;
        }
        if (item.status === status) return item.status;
        if (!canTransit(DIR_STATUS_RULES, item.status, status, from)) return item.status;
        item.status = status;
        if (status === "queued") applyQueuedStartType(item, from);
        if (from !== "parent" && item.parent) {
            await statusMachine(item.parent!, status, "child");
        }
        if (from !== "child") {
            for (const child of item.children ?? []) {
                await statusMachine(child, status, "parent");
            }
        }
        if (["action", "resume", "retry"].includes(from)) {
            runNext();
        }
        return status;
    }

    /**
     *  文件任务状态机
     *
     * queued：error[retry|parent], paused[resume|parent],
     * running: queued[task]
     * paused: running[action|parent], queued[action|parent]
     * cancelled: *[action|parent],
     * success: running[task]
     * error: running[task]
     *
     * */
    async function fileStatusMachine(item: TransferItem, status: TransferStatus, from: SetStatusFrom): Promise<TransferStatus> {
        if (item.status === status) return item.status;
        if (!canTransit(FILE_STATUS_RULES, item.status, status, from)) return item.status;
        const prev = item.status;
        // 先通知后端停，再改本地状态；停的过程中任务可能已经自己结束
        if (status === "paused" && item.requestId) {
            item.loadingFlag = "stop";
            try {
                await sftpTransferPause(item.requestId);
            } finally {
                item.loadingFlag = "none";
            }
            if (item.status !== prev) return item.status;
            if (!canTransit(FILE_STATUS_RULES, item.status, status, from)) return item.status;
        } else if (status === "cancelled" && item.requestId) {
            await sftpTransferCancel(item.requestId);
            if (item.status !== prev) return item.status;
            if (!canTransit(FILE_STATUS_RULES, item.status, status, from)) return item.status;
        }
        item.status = status;
        if (status === "queued") applyQueuedStartType(item, from);
        if (status === "running") item.startedAt = new Date();
        if (status === "success" || status === "cancelled" || status === "error") {
            item.endedAt = new Date();
        }
        if (from !== "parent" && item.parent) {
            await statusMachine(item.parent, status, "child");
        }
        // 运行中任务结束时，running计数减1
        if (prev === "running") running -= 1;
        if (
            ["action", "task", "resume", "retry"].includes(from) &&
            ["cancelled", "success", "error", "paused", "queued"].includes(status)
        ) {
            runNext();
        }
        return status;
    }

    return {
        generateLoading,
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

/** 开发环境下接收 Store 热更新，同时保留当前 Store 状态 */
if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useDownloadStore, import.meta.hot));
}
