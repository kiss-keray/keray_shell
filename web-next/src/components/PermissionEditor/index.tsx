"use client";

import { useEffect, useState } from "react";
import "./index.scss";

type PermRole = "owner" | "group" | "other";
type PermField = "r" | "w" | "x";

export type PermissionEditorProps = {
    title?: string;
    path?: string;
    modelValue?: number;
    confirmText?: string;
    cancelText?: string;
    onConfirm?: (value: number) => void;
    onCancel?: () => void;
};

const roles: { key: PermRole; label: string; shift: number }[] = [
    { key: "owner", label: "所有者", shift: 6 },
    { key: "group", label: "组", shift: 3 },
    { key: "other", label: "其他", shift: 0 },
];
const fields: { key: PermField; label: string; mask: number }[] = [
    { key: "r", label: "读取", mask: 4 },
    { key: "w", label: "写入", mask: 2 },
    { key: "x", label: "执行", mask: 1 },
];

export default function PermissionEditor({ title = "修改文件权限", path = "", modelValue = 0, confirmText = "确定", cancelText = "取消", onConfirm, onCancel }: PermissionEditorProps) {
    const [permBits, setPermBits] = useState(modelValue & 0o777);

    useEffect(() => {
        setPermBits(modelValue & 0o777);
    }, [modelValue]);

    function isChecked(shift: number, mask: number): boolean {
        return ((permBits >> shift) & mask) === mask;
    }

    function toggle(shift: number, mask: number, checked: boolean) {
        const bit = mask << shift;
        setPermBits((current) => (checked ? current | bit : current & ~bit));
    }

    return (
        <div className="PermissionEditor perm-mask" onClick={onCancel}>
            <div className="perm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <p className="perm-title">{title}</p>
                {path ? <p className="perm-path">{path}</p> : null}
                <table className="perm-table">
                    <thead>
                        <tr>
                            <th></th>
                            {fields.map((field) => (
                                <th key={field.key}>{field.label}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {roles.map((role) => (
                            <tr key={role.key}>
                                <th>{role.label}</th>
                                {fields.map((field) => (
                                    <td key={field.key}>
                                        <input type="checkbox" checked={isChecked(role.shift, field.mask)} onChange={(event) => toggle(role.shift, field.mask, event.target.checked)} />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div className="perm-actions">
                    <button type="button" className="perm-btn secondary" onClick={onCancel}>
                        {cancelText}
                    </button>
                    <button type="button" className="perm-btn" onClick={() => onConfirm?.(permBits & 0o777)}>
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
