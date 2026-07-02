import { UnlistenFn } from "@tauri-apps/api/event";
import { DependencyList, useEffect } from "react";

export function useAsyncUnlisten(setup: () => Promise<UnlistenFn>, deps: DependencyList) {
    useEffect(() => {
        let disposed = false;
        let cleanup: UnlistenFn | null = null;

        void setup()
            .then((unlisten) => {
                if (disposed) unlisten();
                else cleanup = unlisten;
            })
            .catch((err) => {
                if (!disposed) console.error("注册监听失败", err);
            });

        return () => {
            disposed = true;
            cleanup?.();
            cleanup = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps]);
}
