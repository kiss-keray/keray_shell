import { baseName } from "@/utils/fsUtil";
import type { VNodeChild } from "vue";

type FileConfirmItem = { id: string };

function fileList(items: FileConfirmItem[]) {
    return (
        <ul class="confirm-file-list">
            {items.map((v) => (
                <li key={v.id} class="confirm-file-item" title={v.id}>
                    <span class="confirm-file-path">{v.id}</span>
                </li>
            ))}
        </ul>
    );
}

/** 删除确认弹窗正文 */
export function buildDeleteConfirmMessage(items: FileConfirmItem[]): VNodeChild {
    const count = items.length;
    return (
        <div class="confirm-danger-body">
            <p class="confirm-intro">确定删除以下 {count} 项吗？</p>
            {fileList(items)}
            <p class="confirm-danger-note">此操作不可恢复。</p>
        </div>
    );
}

/** 移动确认弹窗正文 */
export function buildMoveConfirmMessage(items: FileConfirmItem[], targetDir: string): VNodeChild {
    const count = items.length;
    return (
        <div class="confirm-danger-body">
            <p class="confirm-intro">确定移动以下 {count} 项吗？</p>
            {fileList(items)}
            <p class="confirm-intro">移动到：</p>
            <p class="confirm-target">
                <code>{targetDir}</code>
            </p>
            <p class="confirm-danger-note">此操作不可恢复。</p>
        </div>
    );
}
