"use client";

import { useEffect, useRef, useState } from "react";
import SystemInput, { type SystemInputExpose } from "@/components/SystemInput";
import "./index.scss";

export type PromptProps = {
    title?: string;
    message?: string;
    modelValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm?: (value: string) => void;
    onCancel?: () => void;
};

export default function Prompt({ title = "请输入", message = "", modelValue = "", placeholder = "", confirmText = "确定", cancelText = "取消", onConfirm, onCancel }: PromptProps) {
    const [inputValue, setInputValue] = useState(modelValue);
    const inputRef = useRef<SystemInputExpose>(null);

    useEffect(() => {
        setInputValue(modelValue);
    }, [modelValue]);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    function confirm() {
        onConfirm?.(inputValue);
    }

    return (
        <div className="Prompt prompt-mask" onClick={onCancel}>
            <div className="prompt-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <p className="prompt-title">{title}</p>
                {message ? <p className="prompt-message">{message}</p> : null}
                <SystemInput
                    ref={inputRef}
                    value={inputValue}
                    onChange={setInputValue}
                    className="prompt-input"
                    placeholder={placeholder}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") confirm();
                        else if (event.key === "Escape") onCancel?.();
                    }}
                />
                <div className="prompt-actions">
                    <button type="button" className="prompt-btn secondary" onClick={onCancel}>
                        {cancelText}
                    </button>
                    <button type="button" className="prompt-btn" onClick={confirm}>
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
