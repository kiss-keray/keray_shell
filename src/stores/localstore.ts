import { appDataDir, join, tempDir } from "@tauri-apps/api/path";
import { BaseDirectory, exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { defineStore } from "pinia";
const DEFAULT_CACHE_FILE = "default.json";
export const RUNTIME_CACHE_FILE = "runtime.json";

type CacheMap = Record<string, unknown>;

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

export const useLocalStore = defineStore("local", () => {
    const { appType, homeDir } = useAppStore();
    const cachePath = new Promise<string>(async (resolve) => {
        const path = await join(await homeDir, ".cache", "keray_shell");
        if (!(await exists(path))) {
            await mkdir(path, { recursive: true });
        }
        resolve(path);
    });
    const dataDir = new Promise<string>(async (resolve) => {
        const path = await appDataDir();
        if (!(await exists(path))) {
            await mkdir(path, { recursive: true });
        }
        resolve(path);
    });
    const tempRootDir = new Promise<string>(async (resolve) => {
        const path = await join(await tempDir(), "keray_shell");
        // 删除临时目录
        try {
            await remove(path, { recursive: true });
        } catch {
            // 忽略
        }
        await mkdir(path, { recursive: true });
        resolve(path);
    });

    async function readCache<T>(key: string, cacheFile: string = DEFAULT_CACHE_FILE): Promise<T | undefined> {
        const path = await join(await cachePath, cacheFile);
        const map = await loadCacheMap(path);
        return map[key] as T | undefined;
    }

    async function writeCache(key: string, value: unknown, cacheFile: string = DEFAULT_CACHE_FILE): Promise<void> {
        const path = await join(await cachePath, cacheFile);
        const map = await loadCacheMap(path);
        map[key] = value;
        await writeTextFile(path, JSON.stringify(map), { create: true });
        fileContentCache.set(path, map);
    }

    async function removeCache(key: string, cacheFile: string = DEFAULT_CACHE_FILE): Promise<void> {
        const path = await join(await cachePath, cacheFile);
        if (!(await exists(path))) return;
        const map = await loadCacheMap(path);
        if (!(key in map)) return;
        delete map[key];
        await writeTextFile(path, JSON.stringify(map), { baseDir: BaseDirectory.AppLocalData, create: true });
        fileContentCache.set(path, map);
    }

    async function clearCache(cacheFile: string = DEFAULT_CACHE_FILE): Promise<void> {
        const path = await join(await cachePath, cacheFile);
        await removeLocalIfAny(path);
    }

    async function readData<T>(dataFile: string): Promise<T | undefined> {
        const path = await join(await dataDir, dataFile);
        return await readFileData<T>(path);
    }

    async function writeData<T>(dataFile: string, data: T): Promise<void> {
        const path = await join(await dataDir, dataFile);
        await writeTextFile(path, JSON.stringify(data), { create: true });
    }

    async function removeData(dataFile: string): Promise<void> {
        const path = await join(await dataDir, dataFile);
        await removeLocalIfAny(path);
    }

    onMounted(async () => {
        // 启动时就删除 肯定是main窗口
        if (appType === "main") {
            clearCache(RUNTIME_CACHE_FILE);
        }
    });

    return {
        tempRootDir,
        readCache,
        writeCache,
        removeCache,
        clearCache,
        readData,
        writeData,
        removeData,
    };
});
