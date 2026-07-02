import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RefreshFileListEventKey, useBus } from "@/hooks/useBus";

function Listener({ onEvent }: { onEvent: () => void }) {
    const bus = useBus();
    bus.on(RefreshFileListEventKey, onEvent);
    return null;
}

function Emitter() {
    const bus = useBus();
    return <button onClick={() => bus.emit(RefreshFileListEventKey)}>emit</button>;
}

describe("useBus", () => {
    it("receives events and cleans up after unmount", () => {
        const onEvent = vi.fn();
        const view = render(
            <>
                <Listener onEvent={onEvent} />
                <Emitter />
            </>,
        );
        act(() => {
            view.getByText("emit").click();
        });
        expect(onEvent).toHaveBeenCalledTimes(1);
        view.unmount();
        const bus = useBusShim();
        act(() => {
            bus.emit(RefreshFileListEventKey);
        });
        expect(onEvent).toHaveBeenCalledTimes(1);
    });
});

function useBusShim() {
    let api: ReturnType<typeof useBus> | null = null;
    function Probe() {
        api = useBus();
        return null;
    }
    const view = render(<Probe />);
    view.unmount();
    return api!;
}
