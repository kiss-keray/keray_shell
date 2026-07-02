import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AES, ECB, PBKDF2, Utf8 } from "crypto-es";
import { basename, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir as readDirectory, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import md5 from "md5";
import { create } from "zustand";
import { treeForEach, treeForEachAsync, treeForMap, uuid, type Spread } from "@/utils";
import { remoteJoin } from "@/utils/fsUtil";
import { invoke } from "@/utils/project";
import { showToast } from "@/utils/ui";
import type { ServerRemoteData } from "@/stores/config";
import { useAppStore } from "@/stores/app";
import { useConfigStore } from "@/stores/config";
import { useLocalStore } from "@/stores/localstore";

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

const DEFAULT_SERVER_DATA_FILE = "serverData.json";
const DEFAULT_PRIVATE_KEY_DATA_FILE = "privateKeyData.json";

function createRootGroup(): ServerGroupModel {
    return {
        type: "group",
        id: "root",
        name: "/",
        createdAt: Date.now(),
        order: 0,
        servers: [],
        children: [],
    };
}

async function syncDataToLocal(dir: string, text: string) {
    if (!(await exists(dir))) throw new Error("本地目录不存在");
    const file = await join(dir, DEFAULT_SERVER_DATA_FILE);
    await writeTextFile(file, text, { create: true, createNew: false });
}

async function syncDataToHttp(url: string, text: string) {
    return await fetch(url, { method: "POST", body: text });
}

async function syncDataToRemoteFile(data: ServerRemoteData, text: string) {
    const { ip, port, user, password, path } = data;
    await invoke("one_write_string", { ip, port, user, password, path: await remoteJoin(path, DEFAULT_SERVER_DATA_FILE), content: text });
}

async function localDownload(dir: string): Promise<string> {
    const file = await join(dir, DEFAULT_SERVER_DATA_FILE);
    if (!(await exists(file))) throw new Error("文件不存在");
    return await readTextFile(file);
}

async function httpDownload(url: string): Promise<string> {
    return await fetch(url, { method: "GET" }).then((res) => res.text());
}

async function remoteFileDownload(data: ServerRemoteData): Promise<string> {
    const { ip, port, user, password, path } = data;
    return await invoke<string>("one_read_string", { ip, port, user, password, path: await remoteJoin(path, DEFAULT_SERVER_DATA_FILE) });
}

const passwordShow = "******";
const encryptedPasswordAesKey = "BCHbchsdbchCBDHSCBHSD^&&18133R31"; // 加密密码的AES密钥
const key256 = PBKDF2(encryptedPasswordAesKey, "salt", { keySize: 256 / 32 });

export type ServerDataState = {
    serverRootGroup: ServerGroupModel;
    privateKeyData: PrivateKeyModel[];
    passwordShow: string;
    recentlyServerIds: string[];
    initTask: Promise<void>;
    findServerDataById: (id: string, root?: ServerGroupModel) => ServerDataModel | null;
    findGroupById: (id: string) => ServerGroupModel | null;
    addServerGroup: (data: { name: string }, parentGroup: ServerGroupModel) => Promise<ServerGroupModel>;
    addServerData: (serverData: Spread<{ id?: string; createdAt?: number; type?: "server" }, ServerDataModel>, group: ServerGroupModel) => Promise<ServerDataModel | null>;
    deleteServerRow: (data: RowData) => Promise<void>;
    serverDataChange: (data: RowData) => Promise<void>;
    addPrivateKey: (privateKey: Spread<{ id?: string; createdAt?: number }, PrivateKeyModel>) => Promise<PrivateKeyModel | null>;
    deletePrivateKey: (privateKey: PrivateKeyModel) => Promise<void>;
    privateKeyChange: (privateKey: PrivateKeyModel) => Promise<void>;
    addRecentlyServerData: (serverData: ServerDataModel) => Promise<void>;
    deleteRecentlyServerData: (serverData: ServerDataModel) => Promise<void>;
    cleanRecentlyServerData: () => Promise<void>;
    isServerModel: (data: RowData) => data is ServerDataModel;
    isGroupModel: (data: RowData) => data is ServerGroupModel;
    reloadServerData: () => Promise<void>;
    isRoot: (data: RowData) => boolean;
    exportServerData: (list: RowData[]) => Promise<void>;
    importServerData: (parent: ServerGroupModel) => Promise<void>;
    uploadServerData: (syncKey: string) => Promise<void>;
    downloadServerData: (syncKey: string) => Promise<void>;
};

function treeDataProcess(root: ServerGroupModel) {
    treeForEach<ServerGroupModel>(root, (item: ServerGroupModel, parent?: ServerGroupModel) => {
        item.parent = parent;
        // parent/group 是运行时反查引用，写入磁盘时必须像 Vue 版一样剥离，否则 JSON.stringify 会遇到循环结构。
        (item as ServerGroupModel & { toJSON?: () => object }).toJSON = function () {
            return {
                ...this,
                parent: null,
            };
        };
        item.servers.forEach((sv) => {
            sv.group = item;
            (sv as ServerDataModel & { toJSON?: () => object }).toJSON = function () {
                return {
                    ...this,
                    group: null,
                };
            };
        });
    });
}

function encrypt(password: string): string {
    const decrypted = decrypt(password);
    if (decrypted === password) {
        return AES.encrypt(password, key256, { mode: ECB }).toString();
    }
    return password;
}

function decrypt(password: string): string {
    return AES.decrypt(password, key256, { mode: ECB }).toString(Utf8) || password;
}

function isServerModel(data: RowData): data is ServerDataModel {
    return data.type === "server";
}

function isGroupModel(data: RowData): data is ServerGroupModel {
    return data.type === "group";
}

export const useServerDataStore = create<ServerDataState>((set, get) => {
    function notify() {
        set({
            // Zustand selector 依赖引用变化触发 React 重绘；树本身仍保留 Vue 版的原地编辑模型。
            serverRootGroup: { ...get().serverRootGroup },
            privateKeyData: [...get().privateKeyData],
            recentlyServerIds: [...get().recentlyServerIds],
        });
    }

    function serverDataToRust(serverData: ServerDataModel): ServerRustModel {
        const privateKey = get().privateKeyData.find((item) => item.id === serverData.prkId);
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

    function syncServerDataToRust() {
        const list: ServerRustModel[] = [];
        treeForEach<ServerGroupModel>(get().serverRootGroup, (item) => {
            item.servers.forEach((sv) => list.push(serverDataToRust(sv)));
        });
        invoke("sync_server_data", { servers: list }).catch(console.error);
    }

    async function saveServerData() {
        syncServerDataToRust();
        treeDataProcess(get().serverRootGroup);
        await useLocalStore.getState().writeData(DEFAULT_SERVER_DATA_FILE, get().serverRootGroup);
        await emitTo({ kind: "Any" }, SERVER_CHANGED_EVENT, useAppStore.getState().label);
        const syncKey = useConfigStore.getState().serverSyncKey;
        if (syncKey) void get().uploadServerData(syncKey);
        notify();
    }

    async function reloadServerData() {
        const data = await useLocalStore.getState().readData<ServerGroupModel>(DEFAULT_SERVER_DATA_FILE);
        if (!data) return;
        treeDataProcess(data);
        set({ serverRootGroup: data });
        syncServerDataToRust();
    }

    return {
        serverRootGroup: createRootGroup(),
        privateKeyData: [],
        passwordShow,
        recentlyServerIds: [],
        initTask: Promise.resolve(),
        findServerDataById(id, root = get().serverRootGroup) {
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
        },
        findGroupById(id) {
            let group: ServerGroupModel | null = null;
            treeForEach<ServerGroupModel>(get().serverRootGroup, (item) => {
                if (item.id === id) {
                    group = item;
                    return true;
                }
            });
            return group;
        },
        async addServerGroup(data, parentGroup) {
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
            parentGroup.children.push(group);
            await saveServerData();
            return group;
        },
        async addServerData(serverData, group) {
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
            if (serverData.password) serverData.password = encrypt(serverData.password);
            group.servers.push(serverData as ServerDataModel);
            await saveServerData();
            return serverData as ServerDataModel;
        },
        async deleteServerRow(data) {
            if (data.id === "root") return;
            if (isServerModel(data)) data.group!.servers = data.group!.servers.filter((item) => item.id !== data.id);
            else data.parent!.children = data.parent!.children.filter((item) => item.id !== data.id);
            await saveServerData();
        },
        async serverDataChange(data) {
            if (isServerModel(data) && data.password) data.password = encrypt(data.password);
            await saveServerData();
        },
        async addPrivateKey(privateKey) {
            if (get().privateKeyData.find((item) => item.id === privateKey.id)) {
                showToast("私钥已存在", "error");
                return null;
            }
            privateKey.id = uuid();
            privateKey.createdAt = Date.now();
            get().privateKeyData.push(privateKey as PrivateKeyModel);
            await useLocalStore.getState().writeData(DEFAULT_PRIVATE_KEY_DATA_FILE, get().privateKeyData);
            notify();
            return privateKey as PrivateKeyModel;
        },
        async deletePrivateKey(privateKey) {
            set({ privateKeyData: get().privateKeyData.filter((item) => item.id !== privateKey.id) });
            await useLocalStore.getState().writeData(DEFAULT_PRIVATE_KEY_DATA_FILE, get().privateKeyData);
        },
        async privateKeyChange() {
            await useLocalStore.getState().writeData(DEFAULT_PRIVATE_KEY_DATA_FILE, get().privateKeyData);
            notify();
        },
        async addRecentlyServerData(serverData) {
            const recentlyServerIds = get().recentlyServerIds.filter((item) => item !== serverData.id);
            recentlyServerIds.push(serverData.id);
            set({ recentlyServerIds });
            await useLocalStore.getState().writeCache(RECENTLY_SERVER_DATA_CACHE_KEY, recentlyServerIds);
        },
        async deleteRecentlyServerData(serverData) {
            const recentlyServerIds = get().recentlyServerIds.filter((item) => item !== serverData.id);
            set({ recentlyServerIds });
            await useLocalStore.getState().writeCache(RECENTLY_SERVER_DATA_CACHE_KEY, recentlyServerIds);
        },
        async cleanRecentlyServerData() {
            set({ recentlyServerIds: [] });
            await useLocalStore.getState().removeCache(RECENTLY_SERVER_DATA_CACHE_KEY);
        },
        isServerModel,
        isGroupModel,
        reloadServerData,
        isRoot(data) {
            return data.id === get().serverRootGroup.id;
        },
        async exportServerData(list) {
            const defaultPath = await join(await useAppStore.getState().homeDir, "Downloads");
            const selected = await open({ title: "选择导出目录", multiple: false, directory: true, defaultPath, canCreateDirectories: false });
            if (!selected || Array.isArray(selected)) return;
            const exportServer = async (dir: string, item: ServerDataModel) => {
                const data = { ...item, groupId: "", group: undefined } as ServerDataExportModel;
                if (data.prkId) {
                    const privateKeyValue = get().privateKeyData.find((item) => item.id === data.prkId);
                    if (privateKeyValue) {
                        data.privateKeyName = privateKeyValue.name;
                        data.privateKey = privateKeyValue.content;
                        data.passphrase = privateKeyValue.passphrase;
                    }
                }
                await writeTextFile(await join(dir, `${data.name}_keray_export.json`), JSON.stringify(data), { create: true, createNew: true });
            };
            for (const item of list) {
                if (isServerModel(item)) await exportServer(selected, item);
                else {
                    type ServerGroupModelWithDir = ServerGroupModel & { dir: string };
                    const treeMap = await treeForMap<ServerGroupModel, ServerGroupModelWithDir>(item, async (group: ServerGroupModel) => ({ ...group, dir: "" }));
                    await treeForEachAsync<ServerGroupModelWithDir>(treeMap, async (group, parent) => {
                        const dir = group.id === get().serverRootGroup.id ? selected : await join(parent?.dir ?? selected, group.name);
                        group.dir = dir;
                        await mkdir(dir, { recursive: true });
                        for (const sv of group.servers) await exportServer(dir, sv);
                    });
                }
            }
        },
        async importServerData(parent) {
            const defaultPath = await join(await useAppStore.getState().homeDir, "Downloads");
            const selected =
                useAppStore.getState().osType === "macos"
                    ? await invoke<string[]>("pick_file_or_folder", { title: "导入", multiple: true, defaultPath })
                    : await open({ title: "导入", multiple: true, directory: true, defaultPath });
            if (!selected) return;
            const selectedPaths = Array.isArray(selected) ? selected : [selected];
            const readFile = async (filePath: string, group: ServerGroupModel) => {
                if (!filePath.endsWith("_keray_export.json")) return;
                const dataJson = JSON.parse(await readTextFile(filePath)) as ServerDataExportModel;
                let prkId = dataJson.prkId;
                if (dataJson.privateKeyName && dataJson.privateKey) {
                    const existingPrivateKey = get().privateKeyData.find((item) => item.name === dataJson.privateKeyName);
                    // 导入文件可能内嵌私钥；保持 Vue 版规则：不存在或内容不同则新建，避免覆盖用户已有私钥。
                    if (!existingPrivateKey || existingPrivateKey.content !== dataJson.privateKey || existingPrivateKey.passphrase !== dataJson.passphrase) {
                        const newPrivateKey = await get().addPrivateKey({
                            name: existingPrivateKey ? `${dataJson.privateKeyName}_${Date.now()}` : dataJson.privateKeyName,
                            content: dataJson.privateKey,
                            passphrase: dataJson.passphrase,
                        });
                        prkId = newPrivateKey?.id;
                    }
                }
                await get().addServerData({ ...dataJson, prkId, groupId: group.id, order: dataJson.order }, group);
            };
            const readDirectoryTree = async (dir: string, groupParent: ServerGroupModel) => {
                const name = await basename(dir);
                const group = await get().addServerGroup({ name }, groupParent);
                for (const file of await readDirectory(dir)) {
                    const filePath = await join(dir, file.name);
                    if ((await stat(filePath)).isDirectory) await readDirectoryTree(filePath, group);
                    else await readFile(filePath, group);
                }
            };
            for (const path of selectedPaths) {
                if ((await stat(path)).isDirectory) await readDirectoryTree(path, parent);
                else await readFile(path, parent);
            }
            await reloadServerData();
        },
        async uploadServerData(syncKey) {
            const root = treeForMap(get().serverRootGroup, (item: ServerGroupModel) => ({
                ...item,
                parent: undefined,
                servers: item.servers.map((sv) => ({ ...sv, group: undefined })),
            }));
            const text = JSON.stringify({ server: root, privateKeyData: get().privateKeyData } satisfies ServerDataSyncModel);
            const encryptText = AES.encrypt(text, md5(syncKey)).toString();
            const config = useConfigStore.getState();
            if (config.serverSyncType === "localFile") await syncDataToLocal(config.serverSyncData as string, encryptText);
            else if (config.serverSyncType === "http") await syncDataToHttp(config.serverSyncData as string, encryptText);
            else if (config.serverSyncType === "remoteFile") await syncDataToRemoteFile(config.serverSyncData as ServerRemoteData, encryptText);
        },
        async downloadServerData(syncKey) {
            const config = useConfigStore.getState();
            let text = "";
            if (config.serverSyncType === "localFile") text = await localDownload(config.serverSyncData as string);
            else if (config.serverSyncType === "http") text = await httpDownload(config.serverSyncData as string);
            else if (config.serverSyncType === "remoteFile") text = await remoteFileDownload(config.serverSyncData as ServerRemoteData);
            if (!text) throw new Error("同步数据为空");
            const decryptText = AES.decrypt(text, md5(syncKey)).toString(Utf8);
            if (!decryptText) throw new Error("同步Key错误");
            const data = JSON.parse(decryptText) as ServerDataSyncModel;
            treeDataProcess(data.server);
            set({ serverRootGroup: data.server, privateKeyData: data.privateKeyData });
            await get().serverDataChange(data.server);
        },
    };
});

let serverDataInited = false;
let serverDataUnlisten: UnlistenFn | null = null;

/** 服务器数据加载和跨窗口监听延后到客户端 init，避免 store 创建时读磁盘或访问窗口。 */
export async function initServerDataStore(): Promise<void> {
    if (serverDataInited || typeof window === "undefined") return;
    serverDataInited = true;
    const store = useServerDataStore.getState();
    const initTask = (async () => {
        await store.reloadServerData();
        const privateKeys = await useLocalStore.getState().readData<PrivateKeyModel[]>(DEFAULT_PRIVATE_KEY_DATA_FILE);
        if (privateKeys) useServerDataStore.setState({ privateKeyData: privateKeys });
        const recent = await useLocalStore.getState().readCache<string[]>(RECENTLY_SERVER_DATA_CACHE_KEY);
        if (recent) {
            await store.reloadServerData();
            useServerDataStore.setState({ recentlyServerIds: recent });
        }
    })();
    useServerDataStore.setState({ initTask });
    const win = getCurrentWindow();
    serverDataUnlisten = await win.listen<string>(SERVER_CHANGED_EVENT, async ({ payload: sourceLabel }) => {
        if (sourceLabel === win.label) return;
        await useServerDataStore.getState().reloadServerData();
    });
}

export function disposeServerDataStoreListeners(): void {
    serverDataUnlisten?.();
    serverDataUnlisten = null;
    serverDataInited = false;
}
