"use client";

import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes } from "react";
import "./index.scss";

export type SystemInputExpose = {
    focus: (options?: FocusOptions) => void;
    blur: () => void;
    select: () => void;
};

export type SystemInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
    value?: string;
    onChange?: (value: string) => void;
};

const SystemInput = forwardRef<SystemInputExpose, SystemInputProps>(function SystemInput({ value, onChange, onKeyDown, className, ...attrs }, ref) {
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
        focus: (options?: FocusOptions) => inputRef.current?.focus(options),
        blur: () => inputRef.current?.blur(),
        select: () => inputRef.current?.select(),
    }));

    return (
        <input
            ref={inputRef}
            value={value ?? ""}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            className={className ? `SystemInput ${className}` : "SystemInput"}
            {...attrs}
            onChange={(event) => onChange?.(event.target.value)}
            onKeyDown={(event) => {
                event.stopPropagation();
                onKeyDown?.(event);
            }}
        />
    );
});

export default SystemInput;
