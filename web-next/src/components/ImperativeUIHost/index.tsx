"use client";

import { useCallback, useEffect } from "react";
import Confirm from "@/components/Confirm";
import PermissionEditor from "@/components/PermissionEditor";
import Prompt from "@/components/Prompt";
import { useKeyEventStore } from "@/stores/keyEvent";
import { PRIORITY_HIGHEST } from "@/stores/reactBodyEvent";

import { useImperativeUIStore, type ConfirmRequest, type PermissionEditorRequest, type PromptRequest } from "@/utils/ui";
import "./index.scss";

function ConfirmEntry({ request }: { request: ConfirmRequest }) {
    const close = useImperativeUIStore((state) => state.close);

    const finish = useCallback(
        (value: boolean) => {
            close(request.id);
            request.resolve(value);
        },
        [close, request],
    );

    useEffect(() => {
        // 与 Vue showConfirm 保持一致：每个 Confirm 挂载时只注册一次全局快捷键，卸载时注销。
        return useKeyEventStore.getState().register((event) => {
            if (event.key === "Escape") {
                finish(false);
                return true;
            }
            if (event.key === "Enter") {
                finish(true);
                return true;
            }
            return false;
        }, PRIORITY_HIGHEST);
    }, [finish]);

    return (
        <Confirm
            visible
            title={request.title}
            message={request.message}
            confirmText={request.confirmText}
            cancelText={request.cancelText}
            danger={request.danger}
            onConfirm={() => finish(true)}
            onCancel={() => finish(false)}
        />
    );
}

function PromptEntry({ request }: { request: PromptRequest }) {
    const close = useImperativeUIStore((state) => state.close);
    const finish = (value: string | null) => {
        close(request.id);
        request.resolve(value);
    };
    return (
        <Prompt
            title={request.title}
            message={request.message}
            modelValue={request.defaultValue}
            placeholder={request.placeholder}
            confirmText={request.confirmText}
            cancelText={request.cancelText}
            onConfirm={(value) => finish(value)}
            onCancel={() => finish(null)}
        />
    );
}

function PermissionEditorEntry({ request }: { request: PermissionEditorRequest }) {
    const close = useImperativeUIStore((state) => state.close);
    const finish = (value: number | null) => {
        close(request.id);
        request.resolve(value);
    };
    return (
        <PermissionEditor
            title={request.title}
            path={request.path}
            modelValue={request.defaultValue}
            confirmText={request.confirmText}
            cancelText={request.cancelText}
            onConfirm={(value) => finish(value)}
            onCancel={() => finish(null)}
        />
    );
}

export default function ImperativeUIHost() {
    const requests = useImperativeUIStore((state) => state.requests);
    return (
        <div className="ImperativeUIHost">
            {requests.map((request) => {
                if (request.kind === "confirm") return <ConfirmEntry key={request.id} request={request} />;
                if (request.kind === "permission") return <PermissionEditorEntry key={request.id} request={request} />;
                return <PromptEntry key={request.id} request={request} />;
            })}
        </div>
    );
}
