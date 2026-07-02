import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSClick } from "@/hooks/useSClick";

function TestButton({ onClick }: { onClick: (event: MouseEvent) => void }) {
    const ref = useRef<HTMLButtonElement>(null);
    useSClick(ref, onClick);
    return <button ref={ref}>target</button>;
}

describe("useSClick", () => {
    it("fires when mouse does not drag", () => {
        const fn = vi.fn();
        render(<TestButton onClick={fn} />);
        const target = screen.getByText("target");
        fireEvent.mouseDown(target, { clientX: 10, clientY: 10 });
        fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("ignores click after moving beyond threshold", () => {
        const fn = vi.fn();
        render(<TestButton onClick={fn} />);
        const target = screen.getByText("target");
        fireEvent.mouseDown(target, { clientX: 10, clientY: 10 });
        fireEvent.mouseMove(window, { clientX: 30, clientY: 10 });
        fireEvent.mouseUp(window, { clientX: 30, clientY: 10 });
        expect(fn).not.toHaveBeenCalled();
    });
});
