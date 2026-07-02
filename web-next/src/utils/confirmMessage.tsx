import { baseName } from "@/utils/fsUtil";
import type { ReactNode } from "react";

type FileConfirmItem = { id: string };

function fileList(items: FileConfirmItem[]) {
    return (
        <ul className="confirm-file-list">
            {items.map((v) => (
                <li key={v.id} className="confirm-file-item" title={v.id}>
                    <span className="confirm-file-path">{v.id}</span>
                </li>
            ))}
        </ul>
    );
}

/** 删除确认弹窗正文 */
export function buildDeleteConfirmMessage(items: FileConfirmItem[]): ReactNode {
    const count = items.length;
    return (
        <div className="confirm-danger-body">
            <p className="confirm-intro">确定删除以下 {count} 项吗？</p>
            {fileList(items)}
            <p className="confirm-danger-note">此操作不可恢复。</p>
        </div>
    );
}

/** 移动确认弹窗正文 */
export function buildMoveConfirmMessage(items: FileConfirmItem[], targetDir: string): ReactNode {
    const count = items.length;
    return (
        <div className="confirm-danger-body">
            <p className="confirm-intro">确定移动以下 {count} 项吗？</p>
            {fileList(items)}
            <p className="confirm-intro">移动到：</p>
            <p className="confirm-target">
                <code>{targetDir}</code>
            </p>
            <p className="confirm-danger-note">此操作不可恢复。</p>
        </div>
    );
}

export function buildRenameConfirmMessage(path: string): ReactNode {
    return (
        <div className="confirm-danger-body">
            <p className="confirm-intro">确定重命名以下文件吗？</p>
            <p className="confirm-target">
                <code>{baseName(path)}</code>
            </p>
        </div>
    );
}
