"use client";

import type { ConfirmMessage } from "@/utils/ui";
import "./index.scss";

export type ConfirmProps = {
    visible: boolean;
    title?: string;
    message: ConfirmMessage;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
};

function renderMessage(message: ConfirmMessage) {
    if (typeof message === "string") {
        return <div dangerouslySetInnerHTML={{ __html: message }} />;
    }
    return typeof message === "function" ? message() : message;
}

export default function Confirm({ visible, title = "确认操作", message, confirmText = "确定", cancelText = "取消", danger = false, onConfirm, onCancel }: ConfirmProps) {
    if (!visible) return null;
    return (
        <div className="Confirm confirm-mask" onClick={onCancel}>
            <div className="confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <p className="confirm-title">{title}</p>
                <div className="confirm-message">{renderMessage(message)}</div>
                <div className="confirm-actions">
                    <button type="button" className="confirm-btn secondary" onClick={onCancel}>
                        {cancelText}
                    </button>
                    <button type="button" className={`confirm-btn${danger ? " danger" : ""}`} onClick={onConfirm}>
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
