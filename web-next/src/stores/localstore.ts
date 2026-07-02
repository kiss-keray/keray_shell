import { appDataDir, join, tempDir } from "@tauri-apps/api/path";
import { BaseDirectory, exists, mkdir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { create } from "zustand";
import { removeLocalIfAny } from "@/utils/localFsUtils";
import { useAppStore } from "@/stores/app";

const DEFAULT_CACHE_FILE = "default.json";
export const RUNTIME_CACHE_FILE = "runtime.json";

type CacheMap = Record<string, unknown>;

type LocalStoreState = {
    tempRootDir: Promise<string>;
    initTempRootDir: () => Promise<string>;
    readCache: <T>(key: string, cacheFile?: string) => Promise<T | undefined>;
    writeCache: (key: string, value: unknown, cacheFile?: string) => Promise<void>;
    removeCache: (key: string, cacheFile?: string) => Promise<void>;
    clearCache: (cacheFile?: string) => Promise<void>;
    readData: <T>(dataFile: string) => Promise<T | undefined>;
    writeData: <T>(dataFile: string, data: T) => Promise<void>;
    removeData: (dataFile: string) => Promise<void>;
};

const fileContentCache = new Map<string, CacheMap>();

async function readFileData<T>(filePath: string): Promise<T | undefined> {
    try {
        if (!(await exists(filePath))) return undefined;
        const raw = await readTextFile(filePath);
        try {
            return JSON.parse(raw) as T;
        } catch {
            return raw as T;
        }
    } catch {
        return undefined;
    }
}

/** 读取并解析 JSON 缓存文件；不存在或损坏时返回空对象 */
async function loadCacheMap(filePath: string): Promise<CacheMap> {
    try {
        if (fileContentCache.has(filePath)) return fileContentCache.get(filePath) as CacheMap;
        const data = await readFileData<CacheMap>(filePath);
        if (!data) return {};
        fileContentCache.set(filePath, data);
        return data;
    } catch {
        // 忽略解析错误
    }
    return {};
}

const cachePath = async () => {
    const path = await join(await useAppStore.getState().homeDir, ".cache", "keray_shell");
    if (!(await exists(path))) await mkdir(path, { recursive: true });
    return path;
};

const dataDir = async () => {
    const path = await appDataDir();
    if (!(await exists(path))) await mkdir(path, { recursive: true });
    return path;
};

const tempRootDir = async () => {
    const path = await join(await tempDir(), "keray_shell");
    try {
        await remove(path, { recursive: true });
    } catch {
        // 忽略
    }
    await mkdir(path, { recursive: true });
    return path;
};

export const useLocalStore = create<LocalStoreState>(() => ({
    tempRootDir: Promise.resolve(""),
    async initTempRootDir() {
        const dir = tempRootDir();
        useLocalStore.setState({ tempRootDir: dir });
        return await dir;
    },
    async readCache<T>(key: string, cacheFile: string = DEFAULT_CACHE_FILE): Promise<T | undefined> {
        const path = await join(await cachePath(), cacheFile);
        const map = await loadCacheMap(path);
        return map[key] as T | undefined;
    },
    async writeCache(key: string, value: unknown, cacheFile: string = DEFAULT_CACHE_FILE): Promise<void> {
        const path = await join(await cachePath(), cacheFile);
        const map = await loadCacheMap(path);
        map[key] = value;
        await writeTextFile(path, JSON.stringify(map), { create: true });
        fileContentCache.set(path, map);
    },
    async removeCache(key: string, cacheFile: string = DEFAULT_CACHE_FILE): Promise<void> {
        const path = await join(await cachePath(), cacheFile);
        if (!(await exists(path))) return;
        const map = await loadCacheMap(path);
        if (!(key in map)) return;
        delete map[key];
        await writeTextFile(path, JSON.stringify(map), { baseDir: BaseDirectory.AppLocalData, create: true });
        fileContentCache.set(path, map);
    },
    async clearCache(cacheFile: string = DEFAULT_CACHE_FILE): Promise<void> {
        const path = await join(await cachePath(), cacheFile);
        await removeLocalIfAny(path);
    },
    async readData<T>(dataFile: string): Promise<T | undefined> {
        const path = await join(await dataDir(), dataFile);
        return await readFileData<T>(path);
    },
    async writeData<T>(dataFile: string, data: T): Promise<void> {
        const path = await join(await dataDir(), dataFile);
        await writeTextFile(path, JSON.stringify(data), { create: true });
    },
    async removeData(dataFile: string): Promise<void> {
        const path = await join(await dataDir(), dataFile);
        await removeLocalIfAny(path);
    },
}));

let localStoreInited = false;

/** 运行时缓存清理保留在显式 init 中，避免模块加载时触碰 Tauri 文件系统。 */
export async function initLocalStore(): Promise<void> {
    if (localStoreInited || typeof window === "undefined") return;
    localStoreInited = true;
    // Tauri path/fs API 只能在 WebView 运行时调用，避免 Next 静态预渲染阶段触碰原生 API。
    await useLocalStore.getState().initTempRootDir();
    if (useAppStore.getState().appType === "main") {
        await useLocalStore.getState().clearCache(RUNTIME_CACHE_FILE);
    }
}
