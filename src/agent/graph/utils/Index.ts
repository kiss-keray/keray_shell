import { sleep } from "../../subAgent/watchTermResult";

/** 单次最长空等：再长容易错过命令刚结束的窗口，再短 AI 判断会打得太密。 */
const MAX_INCREASING_SLEEP_MS = 8_000;

/**
 * AI 观察退避：次数越多空等越久，少打无效判断。
 * remainingMs 卡住剩余观察预算，避免睡过超时点。
 */
export async function increasingSleep(count: number, baseSleepMs: number, signal?: AbortSignal) {
    const delay = Math.min(baseSleepMs * 2 ** count, MAX_INCREASING_SLEEP_MS);
    await sleep(delay, signal);
}
