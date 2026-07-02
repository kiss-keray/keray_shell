import { create } from "zustand";
import { useReactBodyEventStore } from "./reactBodyEvent";

import { Priority, PRIORITY_HIGH, PRIORITY_HIGHEST, PRIORITY_LOW, PRIORITY_LOWEST, PRIORITY_MEDIUM } from "./reactBodyEvent";

export type KeyEventCallback = (e: React.KeyboardEvent) => boolean;

type KeyEventState = {
    event: React.KeyboardEvent | null;
    isMultiSelectKey: boolean;
    isShiftKey: boolean;
    register: (action: KeyEventCallback, priority?: Priority) => () => void;
};

const actions: Record<Priority, KeyEventCallback[]> = {
    [PRIORITY_LOWEST]: [],
    [PRIORITY_LOW]: [],
    [PRIORITY_MEDIUM]: [],
    [PRIORITY_HIGH]: [],
    [PRIORITY_HIGHEST]: [],
};

export const useKeyEventStore = create<KeyEventState>(() => {
    const { register } = useReactBodyEventStore.getState();
    register("keydown", (e: React.KeyboardEvent) => {
        useKeyEventStore.setState({
            event: e,
            isMultiSelectKey: e.metaKey || e.ctrlKey,
            isShiftKey: e.shiftKey,
        });
        for (let i = PRIORITY_HIGHEST; i >= PRIORITY_LOWEST; i--) {
            const priorityActions = actions[i as Priority];
            for (const action of priorityActions) {
                if (action(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return true;
                }
            }
        }
        return false;
    });
    register("keyup", (e: React.KeyboardEvent) => {
        useKeyEventStore.setState({
            event: null,
            isMultiSelectKey: false,
            isShiftKey: false,
        });
        return false;
    });
    return {
        event: null,
        isMultiSelectKey: false,
        isShiftKey: false,
        register(action, priority = PRIORITY_LOWEST) {
            if (!actions[priority]) actions[priority] = [];
            actions[priority].push(action);
            return () => {
                actions[priority].remove(action);
            };
        },
    };
});
