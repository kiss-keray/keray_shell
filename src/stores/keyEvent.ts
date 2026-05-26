import { defineStore } from "pinia";

export const PRIORITY_LOWEST = 1;
export const PRIORITY_LOW = 2;
export const PRIORITY_MEDIUM = 3;
export const PRIORITY_HIGH = 4;
export const PRIORITY_HIGHEST = 5;

export type Priority = typeof PRIORITY_LOWEST | typeof PRIORITY_LOW | typeof PRIORITY_MEDIUM | typeof PRIORITY_HIGH | typeof PRIORITY_HIGHEST;

export type KeyEventCallback = (e: KeyboardEvent) => boolean;

export const useKeyEventStore = defineStore("keyEvent", () => {
    const event = ref<KeyboardEvent | null>(null);
    const actions: Record<Priority, KeyEventCallback[]> = {
        [PRIORITY_LOWEST]: [],
        [PRIORITY_LOW]: [],
        [PRIORITY_MEDIUM]: [],
        [PRIORITY_HIGH]: [],
        [PRIORITY_HIGHEST]: [],
    };
    console.log("注册按键事件");
    document.body.addEventListener("keydown", (e: KeyboardEvent) => {
        event.value = e;
        for (let i = PRIORITY_HIGHEST; i >= PRIORITY_LOWEST; i--) {
            const _actions = actions[i as Priority];
            for (const action of _actions) {
                if (action(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }
        }
    });
    document.body.addEventListener("keyup", (e: KeyboardEvent) => {
        event.value = null;
    });
    const isMultiSelectKey = computed(() => {
        return event.value?.metaKey || event.value?.ctrlKey || false;
    });
    const isShiftKey = computed(() => {
        return event.value?.shiftKey || false;
    });
    /** 注册按键事件
     * @param action 按键事件回调
     * @param priority 优先级  0为最高优先级
     */
    function register(action: KeyEventCallback, priority: Priority = PRIORITY_LOWEST): () => void {
        if (!actions[priority]) {
            actions[priority] = [];
        }
        actions[priority].push(action);
        return () => {
            actions[priority].remove(action);
        };
    }
    return {
        isMultiSelectKey,
        isShiftKey,
        register,
    };
});
