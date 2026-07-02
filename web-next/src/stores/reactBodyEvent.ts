import { create } from "zustand";
export const PRIORITY_LOWEST = 1;
export const PRIORITY_LOW = 2;
export const PRIORITY_MEDIUM = 3;
export const PRIORITY_HIGH = 4;
export const PRIORITY_HIGHEST = 5;
export type Priority = typeof PRIORITY_LOWEST | typeof PRIORITY_LOW | typeof PRIORITY_MEDIUM | typeof PRIORITY_HIGH | typeof PRIORITY_HIGHEST;

type EventMap = {
    click: React.MouseEvent;
    dblclick: React.MouseEvent;
    mousedown: React.MouseEvent;
    mouseup: React.MouseEvent;
    wheel: React.WheelEvent;
    contextmenu: React.MouseEvent;
    keydown: React.KeyboardEvent;
    keyup: React.KeyboardEvent;
};
export type ReactBodyEvent = keyof EventMap;

export type ReactBodyEventCallback<K extends ReactBodyEvent> = (e: EventMap[K]) => boolean;

function emptyActions<K extends ReactBodyEvent>(): Record<Priority, ReactBodyEventCallback<K>[]> {
    return {
        [PRIORITY_LOWEST]: [],
        [PRIORITY_LOW]: [],
        [PRIORITY_MEDIUM]: [],
        [PRIORITY_HIGH]: [],
        [PRIORITY_HIGHEST]: [],
    };
}

const actions = {
    click: emptyActions<"click">(),
    dblclick: emptyActions<"dblclick">(),
    keydown: emptyActions<"keydown">(),
    keyup: emptyActions<"keyup">(),
    mousedown: emptyActions<"mousedown">(),
    mouseup: emptyActions<"mouseup">(),
    wheel: emptyActions<"wheel">(),
    contextmenu: emptyActions<"contextmenu">(),
};

type ReactEventState = {
    register: <K extends ReactBodyEvent>(type: K, action: ReactBodyEventCallback<K>, priority?: Priority) => () => void;
    handler: <K extends ReactBodyEvent>(type: K, e: EventMap[K]) => void;
};

export const useReactBodyEventStore = create<ReactEventState>(() => ({
    handler<K extends ReactBodyEvent>(type: K, e: EventMap[K]) {
        const list = actions[type];
        for (let i = PRIORITY_HIGHEST; i >= PRIORITY_LOWEST; i--) {
            const priorityActions = list[i as Priority] as ReactBodyEventCallback<K>[];
            for (const action of priorityActions) {
                if (action(e)) {
                    return;
                }
            }
        }
    },
    register<K extends ReactBodyEvent>(type: K, action: ReactBodyEventCallback<K>, priority = PRIORITY_LOWEST) {
        const list = actions[type][priority as Priority] as ReactBodyEventCallback<K>[];
        list.push(action);
        return () => {
            list.remove(action);
        };
    },
}));
