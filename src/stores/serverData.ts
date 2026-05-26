import { treeForEachAsync, treeForMap } from "@/utils";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { defineStore, storeToRefs } from "pinia";
import { AES, ECB, PBKDF2, Utf8 } from "crypto-es";
import { basename, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, stat, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { ServerRemoteData } from "./config";
import md5 from "md5";
import { remoteJoin } from "@/utils/fsUtil";

export type PrivateKeyModel = {
    id: string; // 私钥ID
    name: string; // 私钥名称
    content: string; // 私钥内容
    passphrase?: string; // 私钥密码
    createdAt: number; // 创建时间
};

export interface ServerGroupModel {
    type: "group";
    id: string; // 分组ID
    name: string; // 分组名称
    createdAt: number; // 创建时间
    order: number; // 排序
    servers: ServerDataModel[]; // 服务器列表
    children: ServerGroupModel[]; // 子分组列表
    parent?: ServerGroupModel; // 父分组
}

export interface ServerDataModel {
    type: "server";
    id: string; // 服务器ID
    name: string; // 服务器名称
    ip: string; // 服务器IP
    port: number; // 服务器端口
    user: string; // 服务器用户名
    password?: string; // 服务器密码
    prkId?: string; // 私钥ID
    groupId: string; // 分组ID
    order: number; // 排序
    createdAt: number; // 创建时间
    lastConnectAt?: number; // 最后连接时间
    group?: ServerGroupModel; // 父分组
}

export type ServerRustModel = {
    id: string; // 服务器ID
    ip: string; // 服务器IP
    port: number; // 服务器端口
    user: string; // 服务器用户名
    password?: string; // 服务器密码
    privateKey?: string; // 私钥内容
    passphrase?: string; // 私钥密码
};

export type ServerDataExportModel = Omit<ServerDataModel, "type" | "id" | "groupId" | "createdAt" | "group" | "lastConnectAt"> & {
    privateKeyName?: string; // 私钥名称
    privateKey?: string; // 私钥内容
    passphrase?: string; // 私钥密码
};

export type ServerDataSyncModel = {
    server: ServerGroupModel;
    privateKeyData: PrivateKeyModel[];
};

export type RowData = ServerDataModel | ServerGroupModel;

// 服务器数据修改事件
export const SERVER_CHANGED_EVENT = "SERVER_CHANGED_EVENT";

// 最近访问服务器数据缓存键
export const RECENTLY_SERVER_DATA_CACHE_KEY = "RECENTLY_SERVER_DATA";

// 服务器数据文件
const DEFAULT_SERVER_DATA_FILE = "serverData.json";

// 私钥数据文件
const DEFAULT_PRIVATE_KEY_DATA_FILE = "privateKeyData.json";

// 服务器数据同步到本地目录
async function syncDataToLocal(dir: string, text: string) {
    if (!(await exists(dir))) {
        throw new Error("本地目录不存在");
    }
    const file = await join(dir, DEFAULT_SERVER_DATA_FILE);
    await writeTextFile(file, text, { create: true, createNew: false });
}

// 服务器数据同步到http
async function syncDataToHttp(url: string, text: string) {
    return await fetch(url, {
        method: "POST",
        body: text,
    });
}

// 服务器数据同步到远程文件 远程文件
async function syncDataToRemoteFile(data: ServerRemoteData, text: string) {
    const { ip, port, user, password, path } = data;
    await invoke("one_write_string", { ip, port, user, password, path: await remoteJoin(path, DEFAULT_SERVER_DATA_FILE), content: text });
}

// 本地目录下载服务器数据
async function localDownload(dir: string): Promise<string> {
    const file = await join(dir, DEFAULT_SERVER_DATA_FILE);
    if (!(await exists(file))) {
        throw new Error("文件不存在");
    }
    return await readTextFile(file);
}

// http下载服务器数据
async function httpDownload(url: string): Promise<string> {
    return await fetch(url, {
        method: "GET",
    }).then((res) => res.text());
}

// 远程文件下载服务器数据
async function remoteFileDownload(data: ServerRemoteData): Promise<string> {
    const { ip, port, user, password, path } = data;
    return await invoke<string>("one_read_string", { ip, port, user, password, path: await remoteJoin(path, DEFAULT_SERVER_DATA_FILE) });
}

export const useServerDataStore = defineStore("serverData", () => {
    const closeFuns: UnlistenFn[] = [];
    const localStore = useLocalStore();
    const appStore = useAppStore();
    const configStore = useConfigStore();
    const { serverSyncType, serverSyncData, serverSyncKey } = storeToRefs(configStore);
    const { homeDir, osType } = appStore;
    const serverRootGroup = ref<ServerGroupModel>({
        type: "group",
        id: "root",
        name: "/",
        createdAt: Date.now(),
        order: 0,
        servers: [],
        children: [],
    });
    const privateKeyData = ref<PrivateKeyModel[]>([]);
    const recentlyServerIds = ref<string[]>(serverRootGroup.value.servers.map((item) => item.id));
    const passwordShow = "******";
    const encryptedPasswordAesKey = "BCHbchsdbchCBDHSCBHSD^&&18133R31"; // 加密密码的AES密钥
    const key256 = PBKDF2(encryptedPasswordAesKey, "salt", { keySize: 256 / 32 });

    const win = getCurrentWindow();

    function treeDataProcess() {
        treeForEach<ServerGroupModel>(serverRootGroup.value, (item: ServerGroupModel, parent?: ServerGroupModel) => {
            item.parent = parent;
            // @ts-ignore
            item.toJSON = function () {
                return {
                    ...this,
                    parent: null,
                };
            };
            item.servers.forEach((sv) => {
                sv.group = item;
                // @ts-ignore
                sv.toJSON = function () {
                    return {
                        ...this,
                        group: null,
                    };
                };
            });
        });
    }

    /** 加密密码 */
    function encrypt(password: string): string {
        // 机密出来等于本身 说明是明文需要加密
        const decrypted = decrypt(password);
        if (decrypted === password) {
            return AES.encrypt(password, key256, { mode: ECB }).toString();
        }
        return password;
    }

    /** 解密密码 */
    function decrypt(password: string): string {
        return AES.decrypt(password, key256, { mode: ECB }).toString(Utf8) || password;
    }

    // 同步数据到rust
    function syncServerDataToRust() {
        const list: ServerRustModel[] = [];
        treeForEach<ServerGroupModel>(serverRootGroup.value, (item: ServerGroupModel) => {
            item.servers.forEach((sv) => {
                list.push(serverDataToRust(sv));
            });
        });
        invoke("sync_server_data", { servers: list });
    }

    /** 保存服务器数据 */
    async function saveServerData() {
        // 数据更新之前都要处理树形结构 避免引用混乱
        syncServerDataToRust();
        treeDataProcess();
        await localStore.writeData(DEFAULT_SERVER_DATA_FILE, serverRootGroup.value);
        emitTo({ kind: "Any" }, SERVER_CHANGED_EVENT, win.label);
        if (serverSyncKey.value) {
            uploadServerData(serverSyncKey.value);
        }
    }

    /** 根据ID查找服务器数据 */
    function findServerDataById(id: string, root: ServerGroupModel = serverRootGroup.value): ServerDataModel | null {
        let server: ServerDataModel | null = null;
        treeForEach(root, (item: ServerGroupModel) => {
            for (const sv of item.servers) {
                if (sv.id === id) {
                    server = sv;
                    return true;
                }
            }
        });
        return server;
    }

    /** 根据ID查找分组 */
    function findGroupById(id: string): ServerGroupModel | null {
        let group: ServerGroupModel | null = null;
        treeForEach<ServerGroupModel>(serverRootGroup.value, (item: ServerGroupModel) => {
            if (item.id === id) {
                group = item;
                return true;
            }
        });
        return group;
    }

    /** 判断是否是服务器数据 */
    function isServerModel(data: RowData): data is ServerDataModel {
        return data.type === "server";
    }

    function isGroupModel(data: RowData): data is ServerGroupModel {
        return data.type === "group";
    }

    /** 将服务器数据转换为 Rust 模型 */
    function serverDataToRust(serverData: ServerDataModel): ServerRustModel {
        const privateKey = privateKeyData.value.find((item) => item.id === serverData.prkId);
        return {
            id: serverData.id,
            ip: serverData.ip,
            port: serverData.port,
            user: serverData.user,
            password: serverData.password ? decrypt(serverData.password) : undefined,
            privateKey: privateKey?.content,
            passphrase: privateKey?.passphrase,
        };
    }

    /** 添加分组 */
    async function addServerGroup(data: { name: string }, parentGroup: ServerGroupModel): Promise<ServerGroupModel> {
        const maxGroupOrder = parentGroup.children.reduce((max, item) => Math.max(max, item.order), 0);
        const group: ServerGroupModel = {
            type: "group",
            id: uuid(),
            name: data.name,
            createdAt: Date.now(),
            order: maxGroupOrder + 1,
            servers: [],
            children: [],
        };
        parentGroup.children.push(group as ServerGroupModel);
        await saveServerData();
        return group;
    }

    /** 添加服务器数据 */
    async function addServerData(serverData: Spread<{ id?: string; createdAt?: number; type?: "server" }, ServerDataModel>, group: ServerGroupModel): Promise<ServerDataModel | null> {
        if (!group) return null;
        if (group.servers.find((item) => item.name === serverData.name)) {
            showToast("服务器名称已存在", "error");
            return null;
        }
        serverData.id = uuid();
        serverData.createdAt = Date.now();
        serverData.type = "server";
        serverData.group = group;
        serverData.groupId = group.id;
        // 加密密码
        if (serverData.password) {
            serverData.password = encrypt(serverData.password);
        }
        group.servers.push(serverData as ServerDataModel);
        await saveServerData();
        return serverData as ServerDataModel;
    }

    /** 删除数据 */
    async function deleteServerRow(data: RowData) {
        if (data.id === "root") return;
        if (isServerModel(data)) {
            data = data as ServerDataModel;
            data.group!.servers = data.group!.servers.filter((item) => item.id !== data.id);
        } else {
            data = data as ServerGroupModel;
            data.parent!.children = data.parent!.children.filter((item) => item.id !== data.id);
        }
        await saveServerData();
    }

    /** 服务器数据修改 */
    async function serverDataChange(data: RowData) {
        if (isServerModel(data)) {
            const serverData = data as ServerDataModel;
            if (serverData.password) {
                serverData.password = encrypt(serverData.password);
            }
        }
        await saveServerData();
    }

    /** 添加私钥 */
    async function addPrivateKey(privateKey: Spread<{ id?: string; createdAt?: number }, PrivateKeyModel>) {
        if (privateKeyData.value.find((item) => item.id === privateKey.id)) {
            showToast("私钥已存在", "error");
            return null;
        }
        privateKey.id = uuid();
        privateKey.createdAt = Date.now();
        privateKeyData.value.push(privateKey as PrivateKeyModel);
        await localStore.writeData(DEFAULT_PRIVATE_KEY_DATA_FILE, privateKeyData.value);
        return privateKey as PrivateKeyModel;
    }

    /** 删除私钥 */
    async function deletePrivateKey(privateKey: PrivateKeyModel) {
        privateKeyData.value = privateKeyData.value.filter((item) => item.id !== privateKey.id);
        await localStore.writeData(DEFAULT_PRIVATE_KEY_DATA_FILE, privateKeyData.value);
    }

    /** 私钥修改 */
    async function privateKeyChange(privateKey: PrivateKeyModel) {
        await localStore.writeData(DEFAULT_PRIVATE_KEY_DATA_FILE, privateKeyData.value);
    }

    /** 添加最近访问服务器数据 */
    async function addRecentlyServerData(serverData: ServerDataModel) {
        recentlyServerIds.value = recentlyServerIds.value.filter((item) => item !== serverData.id);
        recentlyServerIds.value.push(serverData.id);
        await localStore.writeCache(RECENTLY_SERVER_DATA_CACHE_KEY, recentlyServerIds.value);
    }

    /** 删除最近访问服务器数据 */
    async function deleteRecentlyServerData(serverData: ServerDataModel) {
        recentlyServerIds.value = recentlyServerIds.value.filter((item) => item !== serverData.id);
        await localStore.writeCache(RECENTLY_SERVER_DATA_CACHE_KEY, recentlyServerIds.value);
    }

    /** 清理最近访问服务器数据 */
    async function cleanRecentlyServerData() {
        recentlyServerIds.value = [];
        await localStore.removeCache(RECENTLY_SERVER_DATA_CACHE_KEY);
    }

    async function reloadServerData() {
        await localStore.readData<ServerGroupModel>(DEFAULT_SERVER_DATA_FILE).then((data) => {
            if (!data) return;
            serverRootGroup.value = data;
            treeDataProcess();
            syncServerDataToRust();
        });
    }

    /** 导出服务器数据 */
    async function exportServerData(list: RowData[]) {
        // 选择一个目录
        const defaultPath = await join(await homeDir, "Downloads");
        const selected = await open({
            title: "选择导出目录",
            multiple: false,
            directory: true,
            defaultPath,
            canCreateDirectories: false,
        });
        if (!selected || Array.isArray(selected)) return;
        const exportServer = async (dir: string, item: ServerDataModel) => {
            const data = {
                ...item,
                groupId: "",
                group: undefined,
            } as ServerDataExportModel;
            if (data.prkId) {
                const privateKeyValue = privateKeyData.value.find((item) => item.id === data.prkId);
                if (privateKeyValue) {
                    data.privateKeyName = privateKeyValue.name;
                    data.privateKey = privateKeyValue.content;
                    data.passphrase = privateKeyValue.passphrase;
                }
            }
            writeTextFile(await join(dir, `${data.name}_keray_export.json`), JSON.stringify(data), { create: true, createNew: true });
        };
        for (const item of list) {
            if (isServerModel(item)) {
                await exportServer(selected, item);
            } else if (isGroupModel(item)) {
                type ServerGroupModelWithDir = ServerGroupModel & { dir: string };
                const treeMap = await treeForMap<ServerGroupModel, ServerGroupModelWithDir>(item, async (item: ServerGroupModel) => {
                    return {
                        ...item,
                        dir: "",
                    };
                });
                treeForEachAsync<ServerGroupModelWithDir>(treeMap, async (item: ServerGroupModelWithDir, parent?: ServerGroupModelWithDir) => {
                    const dir = item.id === serverRootGroup.value.id ? selected : await join(parent?.dir ?? selected, item.name);
                    item.dir = dir;
                    await mkdir(dir, { recursive: true });
                    for (const sv of item.servers) {
                        await exportServer(dir, sv);
                    }
                });
            }
        }
    }

    /** 导入服务器数据 */
    async function importServerData(parent: ServerGroupModel) {
        const defaultPath = await join(await homeDir, "Downloads");
        const selected =
            osType === "macos"
                ? await invoke<string[]>("pick_file_or_folder", { title: "导入", multiple: true, defaultPath })
                : await open({
                      title: "导入",
                      multiple: true,
                      directory: true,
                      defaultPath,
                  });
        if (!selected) return;
        /** 读取文件导入服务器数据 */
        async function __readFile(filePath: string, parent: ServerGroupModel) {
            if (!filePath.endsWith("_keray_export.json")) return;
            const data = await readTextFile(filePath);
            const dataJson = JSON.parse(data) as ServerDataExportModel;
            let prkId = dataJson.prkId;
            if (dataJson.privateKeyName && dataJson.privateKey) {
                const { privateKeyName, privateKey, passphrase } = dataJson;
                const exitPrivateKey = privateKeyData.value.find((item) => item.name === privateKeyName);
                // 如果不存在私钥或者存在的私钥不一样  新建私钥
                if (!exitPrivateKey || exitPrivateKey.content !== privateKey || exitPrivateKey.passphrase !== passphrase) {
                    const newPrivateKey = await addPrivateKey({ name: exitPrivateKey ? `${privateKeyName}_${Date.now()}` : privateKeyName, content: privateKey, passphrase: passphrase });
                    prkId = newPrivateKey!.id;
                }
            }
            await addServerData(
                {
                    name: dataJson.name,
                    ip: dataJson.ip,
                    port: dataJson.port,
                    user: dataJson.user,
                    password: dataJson.password,
                    prkId,
                    groupId: parent.id,
                    order: dataJson.order,
                },
                parent,
            );
        }
        /** 读取目录导入分组和服务器 */
        async function __readDir(dir: string, parent: ServerGroupModel) {
            const name = await basename(dir);
            const group = await addServerGroup({ name }, parent);
            const files = await readDir(dir);
            for (const file of files) {
                const filePath = await join(dir, file.name);
                const isDir = await stat(filePath).then((stat) => stat.isDirectory);
                if (isDir) {
                    await __readDir(filePath, group);
                } else {
                    await __readFile(filePath, group);
                }
            }
        }
        for (const path of selected) {
            const isDir = await stat(path).then((stat) => stat.isDirectory);
            if (isDir) {
                await __readDir(path, parent);
            } else {
                await __readFile(path, parent);
            }
        }
        reloadServerData();
    }

    /** 上传服务器数据 */
    async function uploadServerData(syncKey: string) {
        const root = treeForMap(serverRootGroup.value, (item: ServerGroupModel) => {
            const servers = item.servers.map((sv) => {
                const server: ServerDataModel = {
                    ...sv,
                    group: undefined,
                };
                return server;
            });
            const group: ServerGroupModel = {
                ...item,
                parent: undefined,
                servers: servers,
            };
            return group;
        });
        const syncData: ServerDataSyncModel = {
            server: root,
            privateKeyData: privateKeyData.value,
        };
        const text = JSON.stringify(syncData);
        // md5成32位
        const aesKey = md5(syncKey);
        const encryptText = AES.encrypt(text, aesKey).toString();
        if (serverSyncType.value === "localFile") {
            await syncDataToLocal(serverSyncData.value as string, encryptText);
        } else if (serverSyncType.value === "http") {
            await syncDataToHttp(serverSyncData.value as string, encryptText);
        } else if (serverSyncType.value === "remoteFile") {
            await syncDataToRemoteFile(serverSyncData.value as ServerRemoteData, encryptText);
        }
    }

    /** 下载服务器数据 */
    async function downloadServerData(syncKey: string) {
        let text: string = "";
        if (serverSyncType.value === "localFile") {
            text = await localDownload(serverSyncData.value as string);
        } else if (serverSyncType.value === "http") {
            text = await httpDownload(serverSyncData.value as string);
        } else if (serverSyncType.value === "remoteFile") {
            text = await remoteFileDownload(serverSyncData.value as ServerRemoteData);
        }
        if (!text) {
            throw new Error("同步数据为空");
        }
        let decryptText: string = "";
        try {
            const aesKey = md5(syncKey);
            decryptText = AES.decrypt(text, aesKey).toString(Utf8);
        } catch (error) {
            throw new Error("同步Key错误");
        }
        const data = JSON.parse(decryptText) as ServerDataSyncModel;
        serverRootGroup.value = data.server;
        privateKeyData.value = data.privateKeyData;
        await serverDataChange(serverRootGroup.value);
    }

    const initTask = reloadServerData();
    localStore.readData<PrivateKeyModel[]>(DEFAULT_PRIVATE_KEY_DATA_FILE).then((data) => {
        if (!data) return;
        privateKeyData.value = data;
    });
    localStore.readCache<string[]>(RECENTLY_SERVER_DATA_CACHE_KEY).then(async (data) => {
        if (!data) return;
        await reloadServerData();
        recentlyServerIds.value = data;
    });
    win.listen<string>(SERVER_CHANGED_EVENT, async ({ payload: sourceLabel }) => {
        if (sourceLabel === win.label) return;
        await reloadServerData();
    }).then((unlisten) => {
        closeFuns.push(unlisten);
    });

    onUnmounted(() => {
        closeFuns.forEach((unlisten) => unlisten());
    });
    return {
        serverRootGroup,
        privateKeyData,
        passwordShow,
        recentlyServerIds,
        initTask,
        findServerDataById,
        findGroupById,
        addServerGroup,
        addServerData,
        deleteServerRow,
        serverDataChange,
        addPrivateKey,
        deletePrivateKey,
        privateKeyChange,
        addRecentlyServerData,
        deleteRecentlyServerData,
        cleanRecentlyServerData,
        isServerModel,
        isGroupModel,
        reloadServerData,
        isRoot(data: ServerDataModel | ServerGroupModel) {
            return data.id === serverRootGroup.value.id;
        },
        exportServerData,
        importServerData,
        uploadServerData,
        downloadServerData,
    };
});
