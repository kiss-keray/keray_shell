/**
 * 对象的深度复制，将source对象深度拷贝到target对象
 * @param {Object} source
 * @returns {Object}
 */
export function deepClone<T>(source: T): T {
    if (!source || typeof source !== "object") {
        return source;
    }
    const targetObj = Array.isArray(source) ? [] : {};
    Object.keys(source).forEach((keys) => {
        // @ts-ignore
        if (source[keys] && typeof source[keys] === "object") {
            // @ts-ignore
            targetObj[keys] = deepClone(source[keys]);
        } else {
            // @ts-ignore
            targetObj[keys] = source[keys];
        }
    });
    return targetObj as T;
}

type Call1<T> = (data: T, parent?: T, list?: T[]) => boolean | void;
type Call2<T> = (data: T, parent?: T, list?: T[]) => Promise<boolean | void>;

/**
 * 树形结构遍历，浅入深遍历
 * @param data 树形结构数据
 * @param call 回调函数 返回值为是否继续遍历
 * @param getChildren 获取子节点函数
 * @param parent 父节点
 * @param list 列表
 * @returns 是否继续遍历
 */
export function treeForEach<T>(data: T | T[], call: Call1<T>, getChildren?: (data: T) => T[], parent?: T, list?: T[]): boolean {
    if (!getChildren) {
        // @ts-ignore
        getChildren = (v) => v.children;
    }
    if (Array.isArray(data)) {
        for (const item of data) {
            if (treeForEach(item, call, getChildren, parent, data)) return true;
        }
        return false;
    } else {
        const flag = call(data, parent, list);
        if (flag) return flag;
        const children = getChildren(data);
        if (!Array.isArray(children)) return false;
        return treeForEach(children, call, getChildren, data);
    }
}
export async function treeForEachAsync<T>(data: T | T[], call: Call1<T> | Call2<T>, getChildren?: (data: T) => T[] | Promise<T[]>, parent?: T, list?: T[]): Promise<boolean> {
    if (!getChildren) {
        // @ts-ignore
        getChildren = (v) => v.children;
    }
    if (Array.isArray(data)) {
        for (const item of data) {
            if (await treeForEachAsync(item, call, getChildren, parent, data)) return true;
        }
        return false;
    } else {
        const flag = await call(data, parent, list);
        if (flag) return flag;
        const children = await getChildren(data);
        if (!Array.isArray(children)) return false;
        return treeForEachAsync(children, call, getChildren, data);
    }
}

/**
 * 树形结构遍历，深入浅遍历
 * @param data 树形结构数据
 * @param call 回调函数 返回值为是否继续遍历
 * @param getChildren 获取子节点函数
 * @param parent 父节点
 * @param list 列表
 * @returns 是否继续遍历
 */
export function treeForEachDeep<T>(data: T | T[], call: Call1<T>, getChildren?: (data: T) => T[], parent?: T, list?: T[]): boolean {
    if (!getChildren) {
        // @ts-ignore
        getChildren = (v) => v.children;
    }
    if (Array.isArray(data)) {
        for (const item of data) {
            if (treeForEachDeep(item, call, getChildren, parent, data)) return true;
        }
        return false;
    } else {
        const children = getChildren(data);
        if (Array.isArray(children)) {
            const flag = treeForEachDeep(children, call, getChildren, data, list);
            if (flag) return true;
        }
        return call(data, parent!, list!) ?? false;
    }
}
export async function treeForEachDeepAsync<T>(data: T | T[], call: Call1<T> | Call2<T>, getChildren?: (data: T) => T[] | Promise<T[]>, parent?: T, list?: T[]): Promise<boolean> {
    if (!getChildren) {
        // @ts-ignore
        getChildren = (v) => v.children;
    }
    if (Array.isArray(data)) {
        for (const item of data) {
            if (await treeForEachDeepAsync(item, call, getChildren, parent, data)) return true;
        }
        return false;
    } else {
        const children = await getChildren(data);
        if (Array.isArray(children)) {
            const flag = await treeForEachDeepAsync(children, call, getChildren, data, list);
            if (flag) return true;
        }
        return (await call(data, parent!, list!)) ?? false;
    }
}

type CallMap1<T, V> = (data: T, parent?: T, list?: T[]) => V;
type CallMap1Async<T, V> = (data: T, parent?: T, list?: T[]) => Promise<V>;
type CallMap2<T, V> = (data: T) => V;
type CallMap2Async<T, V> = (data: T) => Promise<V>;
type CallMap<T, V> = CallMap1<T, V> | CallMap2<T, V>;
type CallMapAsync<T, V> = CallMap1Async<T, V> | CallMap2Async<T, V>;
/**
 * 树形结构遍历转换
 * @param data 树形结构数据
 * @param call 回调函数 返回值为是否继续遍历
 * @param getChildren 获取子节点函数
 * @param setChildren 设置子节点函数
 * @param parent 父节点
 * @param list 列表
 * @returns 树形结构数据；入参为数组时返回 V[]，入参为单节点时返回 V
 */
export function treeForMap<T, V>(data: T[], call: CallMap<T, V>, getChildren?: (data: T) => T[], setChildren?: (data: V, children: V[]) => void, parent?: T, list?: T[]): V[];
export function treeForMap<T, V>(data: T, call: CallMap<T, V>, getChildren?: (data: T) => T[], setChildren?: (data: V, children: V[]) => void, parent?: T, list?: T[]): V;
export function treeForMap<T, V>(data: T[], call: CallMapAsync<T, V>, getChildren?: (data: T) => T[], setChildren?: (data: V, children: V[]) => void, parent?: T, list?: T[]): Promise<V[]>;
export function treeForMap<T, V>(data: T, call: CallMapAsync<T, V>, getChildren?: (data: T) => T[], setChildren?: (data: V, children: V[]) => void, parent?: T, list?: T[]): Promise<V>;
export function treeForMap<T, V>(
    data: T | T[],
    call: CallMap<T, V> | CallMapAsync<T, V>,
    getChildren?: (data: T) => T[],
    setChildren?: (data: V, children: V[]) => void,
    parent?: T,
    list?: T[],
): V | V[] | Promise<V> | Promise<V[]>;

export function treeForMap<T, V>(
    data: T | T[],
    call: CallMap<T, V> | CallMapAsync<T, V>,
    getChildren?: (data: T) => T[],
    setChildren?: (data: V, children: V[]) => void,
    parent?: T,
    list?: T[],
): V | V[] | Promise<V> | Promise<V[]> {
    if (!getChildren) {
        // @ts-ignore
        getChildren = (v) => v.children;
    }
    if (!setChildren) {
        setChildren = (data, children) => {
            // @ts-ignore
            data.children = children;
        };
    }
    if (Array.isArray(data)) {
        const rs = data.map((item) => treeForMap(item, call, getChildren, setChildren, undefined, data) as V | Promise<V>);
        if (rs.some((r) => r instanceof Promise)) {
            return Promise.all(rs);
        } else {
            return rs as V[];
        }
    } else {
        const children = getChildren(data);
        let childrenMap: V[] | Promise<V[]> | null = null;
        if (Array.isArray(children)) {
            childrenMap = treeForMap(children, call, getChildren, setChildren, data, list) as V[] | Promise<V[]>;
        }
        const map = call(data, parent, list);
        if (map instanceof Promise) {
            return map.then(async (m) => {
                if (childrenMap) setChildren(m, await childrenMap);
                return m;
            }) as Promise<V>;
        } else {
            if (childrenMap) setChildren(map, childrenMap as V[]);
            return map;
        }
    }
}

export type Spread<T1, T2> = Omit<T2, keyof T1> & T1;

export type TreeItemBase = {
    id: string | number;
    parentId?: string | number;
    parent_id?: string | number;
};

export type TreeListItem<T> = {
    level: number;
    children: Spread<T, TreeListItem<T>>[] | null;
    parent: Spread<T, TreeListItem<T>> | null;
    leaf: boolean;
} & TreeItemBase;

/**
 * 将具有树形结构的数组转换为树形结构 树形结构对象的要求时数组的元素对象有parentId，id。parentId指向的就是上级对象的id
 * @param {Array} list
 * @return {Array} 树形结构
 */
export function treeList2Tree<T extends TreeItemBase>(list: T[], firstLevel: number = 1): Spread<T, Spread<T, TreeListItem<T>>>[] {
    type FT = Spread<TreeItemBase, TreeListItem<T>>;
    type RT = Spread<T, TreeListItem<T>>;
    const worked: FT[] = [];
    const setChildren = (parent: FT) => {
        worked.push(parent);
        const children = list.filter((c) => (c.parentId || c.parent_id) === parent.id);
        const haveChildren = children.length > 0;
        parent.leaf = !haveChildren;
        if (haveChildren) {
            parent.children = children as RT[];
            children.forEach((c) => {
                const cx = c as unknown as FT;
                cx.level = parent.level! + 1;
                cx.parent = parent as unknown as RT;
                setChildren(cx);
            });
        } else {
            parent.children = null;
        }
    };
    const listx = list.map((item) => {
        const itemx = item as unknown as FT;
        itemx.level = firstLevel;
        setChildren(itemx);
        return itemx as unknown as RT;
    });
    return listx.filter((v) => !(v as unknown as FT).parent);
}

type objType = Record<string, unknown> | Array<unknown>;
/**
 * 获取任意对象的任意字段值
 * @param obj 对象
 * @param field 字段路径
 * @param def 默认值
 * @returns {*|string}
 */
export function mapGet(obj: objType, field: string = "", def?: any) {
    const eq = (v: any, v1: any): boolean => {
        if (v === v1) return true;
        return v && v.toString() === v1;
    };
    const keyGet = (obj: objType, key: string): unknown => {
        // 非数组 对象时返回undefined
        let result;
        // key为空时 返回原对象
        if (key === "") result = obj;
        // 存在数组filter时 返回数组
        else if (key.includes("=")) {
            if (!Array.isArray(obj)) return def;
            const [k, v] = key.split("=");
            result = (obj as Array<Record<string, unknown>>).filter((el) => eq(el[k as string], v));
        }
        // 数组时map后返回数组
        else if (Array.isArray(obj)) {
            // key是数字时 返回数组中对应下标的值
            if (/^\d+$/.test(key as string)) {
                result = obj[Number(key)];
            }
            // key是字符串时 返回数组中所有对象的对应key的值
            else {
                result = obj.map((v) => keyGet(v as Record<string, unknown>, key));
            }
        }
        // 对象取值返回
        else if (typeof obj === "object" && obj !== null) {
            result = obj[key];
        }
        return result;
    };
    const get = (obj: objType, field: string, def: any) => {
        let key = "";
        for (const char of field) {
            if (char === "." || char === "]" || char === "[") {
                obj = keyGet(obj, key) as objType;
                if (obj === undefined) break;
                key = "";
            } else {
                key = key + char;
            }
        }
        const result = keyGet(obj, key);
        return result === undefined ? def : result;
    };
    // 有+时表示将多个字段拼接后返回
    const fs = field.split("+");
    let result;
    for (const f of fs) {
        // ''包裹的字符串直接返回
        if (f.startsWith("'") && f.endsWith("'")) {
            result = (result || "") + f.substring(1, f.length - 1);

            continue;
        }
        const r = get(obj, f, undefined);
        if (r !== undefined) {
            if (typeof r === "object") {
                return r;
            }
            if (fs.length > 1) result = (result || "") + r;
            else result = r;
        }
    }
    return result === undefined ? def : result;
}

/**
 * 休眠指定的时间
 * @param {Number} time 休眠毫秒
 * @param {Promise}
 * @returns
 */
export function sleep(time: number): Promise<void> {
    return new Promise((r) => {
        setTimeout(() => {
            r();
        }, time);
    });
}

/**
 * 生成uuid字符串
 * @param {Object} list
 * @return {Boolean}
 */
export function uuid(len: number = 32, radix?: number) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split("");
    const uuid = [];
    let i;
    radix = radix || chars.length;
    if (len) {
        for (i = 0; i < len; i++) uuid[i] = chars[0 | (Math.random() * radix)];
    } else {
        let r;
        uuid[8] = uuid[13] = uuid[18] = uuid[23] = "-";
        uuid[14] = "4";
        for (i = 0; i < 36; i++) {
            if (!uuid[i]) {
                r = 0 | (Math.random() * 16);
                uuid[i] = chars[i === 19 ? (r & 0x3) | 0x8 : r];
            }
        }
    }

    return uuid.join("");
}

export function removeArrayItem<T>(array: T[], item: T): T[] {
    const index = array.indexOf(item);
    if (index > -1) {
        array.splice(index, 1);
    }
    return array;
}

/**
 * 在数字前面补0
 * @param num 数字
 * @param length 将数字不足length位时，补位至 length 长度
 * @returns {string} 补位后的结果
 */
export function padZero(num: number, length: number): string {
    let len = num.toString().length;
    let s = num.toString();
    while (len < length) {
        s = "0" + s;
        len++;
    }
    return s;
}

export type CountdownTextStyle = {
    d: string;
    h: string;
    m: string;
    s: string;
    ms: string;
};

/**
 * 倒计时文字
 * @returns
 */
export function countdownText(timeNum: number, style: "zh" | "symbol" | "en" = "symbol", dys: Array<keyof CountdownTextStyle> = ["m", "s"]): string {
    const s = 1000;
    const m = s * 60;
    const h = m * 60;
    const d = h * 24;

    const D = Math.floor(timeNum / d);
    const H = Math.floor((timeNum % d) / h);
    const M = Math.floor((timeNum % h) / m);
    const S = Math.floor((timeNum % m) / s);
    const ms = timeNum % 1000;
    const styleObj = {
        zh: {
            d: "天",
            h: "小时",
            m: "分",
            s: "秒",
            ms: "毫秒",
        },
        en: {
            d: "d",
            h: "h",
            m: "m",
            s: "s",
            ms: "ms",
        },
        symbol: {
            d: " ",
            h: ":",
            m: ":",
            s: "",
            ms: "",
        },
    }[style];
    let text = "";
    const add = (val: number, key: keyof typeof styleObj): string => {
        if (!dys.includes(key)) return "";
        return `${padZero(Number(val), 2)}${styleObj[key]}`;
    };
    text += add(D, "d");
    text += add(H, "h");
    text += add(M, "m");
    text += add(S, "s");
    text += add(ms, "ms");
    return text;
}

export async function awaiting(condition: () => boolean, maxTime: number = 1000, sleepTime: number = 50): Promise<void> {
    for (let i = 0; i < maxTime; i += sleepTime) {
        if (condition()) {
            return;
        }
        await sleep(sleepTime);
    }
    throw new Error("awaiting timeout");
}

/** 计算网速 */
export function calculateSpeedBps(bpsData: Record<number, number>): number {
    const now = Date.now();
    const startTime = now - 5000;
    const list = Object.entries(bpsData).filter(([time]) => Number(time) >= startTime);
    const bps = list.map(([, bps]) => bps).reduce((acc, b) => acc + b, 0);
    const minTime = Math.min(...list.map(([time]) => Number(time)));
    const maxTime = Math.max(...list.map(([time]) => Number(time)));
    return (bps / (maxTime - minTime)) * 1000;
}

declare global {
    interface Array<T> {
        /** 从数组中移除首个匹配的 item，返回自身以支持链式调用 */
        remove(item: T): this;
    }
}

// 给Array原型链添加remove方法
Array.prototype.remove = function <T>(this: T[], item: T): T[] {
    const index = this.indexOf(item);
    if (index > -1) {
        this.splice(index, 1);
    }
    return this;
};
