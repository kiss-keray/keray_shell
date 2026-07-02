"use client";

import AppShell from "@/app/AppShell";
import { useReactBodyEventStore } from "@/stores/reactBodyEvent";

export default function Page() {
    const { handler } = useReactBodyEventStore();
    return (
        <div
            tabIndex={0}
            id="app"
            onClick={(e) => handler("click", e)}
            onKeyDown={(e) => handler("keydown", e)}
            onKeyUp={(e) => handler("keyup", e)}
            onMouseDown={(e) => handler("mousedown", e)}
            onMouseUp={(e) => handler("mouseup", e)}
            onWheel={(e) => handler("wheel", e)}
            onContextMenu={(e) => handler("contextmenu", e)}
            onDoubleClick={(e) => handler("dblclick", e)}
        >
            <AppShell />
        </div>
    );
}
