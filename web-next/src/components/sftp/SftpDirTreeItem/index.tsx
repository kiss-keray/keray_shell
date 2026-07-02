"use client";

import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import Icon from "@/components/Icon";
import type { MenuItem } from "@/components/DefaultMenuItems";
import SystemInput, { type SystemInputExpose } from "@/components/SystemInput";
import { useSftpContext } from "@/components/sftp/context";
import { addFileItem, changeFileItemName, changeFileItemPermissions, deleteFileItem, findTreeItem, loadDirectory, type FileStoreItem } from "@/components/sftp/model";
import useBus, { FileDragEndEventKey, FileDragStartEventKey, RefreshFileListEventKey } from "@/hooks/useBus";
import { useDownloadStore } from "@/stores/downloadStore";
import { CustomMenusEventKey } from "@/utils/constant";
import { baseName, checkLinuxFileName, remoteJoin, remoteMove } from "@/utils/fsUtil";
import { copyText, invoke } from "@/utils/project";
import { useAppStore } from "@/stores/app";
import { buildMoveConfirmMessage } from "@/utils/confirmMessage";
import { showConfirm, showPermissionEditor, showPrompt, showToast } from "@/utils/ui";
import "./index.scss";

export type SftpDirTreeItemProps = {
    item: FileStoreItem;
};

function normalizeDialogPaths(value: string | string[] | null): string[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

export default function SftpDirTreeItem({ item }: SftpDirTreeItemProps) {
    const { server, rootFile, activeItem, setActiveItem, refreshTree } = useSftpContext();
    const appOsType = useAppStore((state) => state.osType);
    const appHomeDir = useAppStore((state) => state.homeDir);
    const setLoadingText = useAppStore((state) => state.setLoadingText);
    const addDownloadTask = useDownloadStore((state) => state.addDownloadTask);
    const addUploadTask = useDownloadStore((state) => state.addUploadTask);
    const { on, emit } = useBus();
    const dragItems = useRef<FileStoreItem[]>([]);
    const activeItemRef = useRef(activeItem);
    const editNameInputRef = useRef<SystemInputExpose | null>(null);
    const [editName, setEditName] = useState<string | null>(null);
    const loaded = item.children !== null;
    const leaf = loaded && !item.children?.some((child) => child.isDir);
    const icon = loaded ? "mdi:folder" : "mdi:folder-outline";
    const isRoot = item.id === "/";

    function commitTree(selectPath = activeItemRef.current.id) {
        setActiveItem(findTreeItem(rootFile, selectPath) ?? findTreeItem(rootFile, activeItemRef.current.id) ?? rootFile);
        refreshTree();
    }

    function clickItem() {
        setActiveItem(item);
    }

    function toggleOpen(event?: React.MouseEvent) {
        event?.stopPropagation();
        item.open = !item.open;
        refreshTree();
    }

    async function createDir() {
        const name = await showPrompt({ title: "新建文件夹", placeholder: "请输入文件夹名称", confirmText: "创建", cancelText: "取消" });
        if (!name) return;
        if (!checkLinuxFileName(name)) {
            showToast("文件名不符合 Linux 文件系统命名规则", "error");
            return;
        }
        const newPath = await addFileItem(server.server.id, item, name, true);
        if (!newPath) return;
        commitTree(newPath);
    }

    function rename() {
        setEditName(baseName(item.id));
    }

    async function confirmName(blur = false) {
        if (!editName) {
            setEditName(null);
            return;
        }
        if (!checkLinuxFileName(editName)) {
            showToast("文件名不符合 Linux 文件系统命名规则", "error");
            if (blur) setEditName(null);
            return;
        }
        await changeFileItemName(server.server.id, item, editName);
        setEditName(null);
        commitTree(item.id);
    }

    function inputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Enter") void confirmName();
        else if (event.key === "Escape") setEditName(null);
    }

    function handleRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        if (item.id === "/" || event.key !== "Enter") return;
        event.stopPropagation();
        setEditName(baseName(item.id));
    }

    async function remove() {
        const ok = await showConfirm({ title: "确认删除", message: "确定要删除该文件吗？", danger: true });
        if (!ok) return;
        await deleteFileItem(server.server.id, item);
        let nextActiveId = activeItem.id;
        for (let parent: FileStoreItem | null = activeItem; parent; parent = parent.parent) {
            if (parent === item) {
                nextActiveId = item.parent?.id ?? "/";
                break;
            }
        }
        commitTree(nextActiveId);
    }

    function uploadFiles(paths: string[], fileItem: FileStoreItem) {
        if (!fileItem.isDir) {
            showToast("请选择上传文件夹", "error");
            return;
        }
        const remoteDir = fileItem.linkPath || fileItem.id;
        const activeWhenQueued = activeItemRef.current;
        addUploadTask({ sessionId: server.sessionId, serverId: server.server.id }, paths, remoteDir, () => {
            if (activeItemRef.current === activeWhenQueued) setActiveItem(fileItem);
            emit(RefreshFileListEventKey);
        });
    }

    async function chmod() {
        const perms = await showPermissionEditor({
            title: "修改文件权限",
            path: item.id,
            defaultValue: item.permissions,
            confirmText: "确定",
            cancelText: "取消",
        });
        if (perms === null) return;
        await changeFileItemPermissions(server.server.id, item, perms).catch((err) => {
            console.error(err);
            showToast("文件权限修改失败", "error");
        });
        refreshTree();
    }

    async function dropMovedFiles(event: React.DragEvent) {
        const moving = [...dragItems.current].filter((moveItem) => moveItem.id !== item.id);
        if (!moving.length) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.classList.remove("drag-over");
        const ok = await showConfirm({
            title: "确认移动",
            message: buildMoveConfirmMessage(moving, item.id),
            danger: true,
        });
        if (!ok) return;
        for (const moveItem of moving) {
            const newPath = await remoteJoin(item.id, baseName(moveItem.id));
            await remoteMove(server.server.id, moveItem.id, newPath);
            moveItem.parent?.children?.remove(moveItem);
        }
        await loadDirectory(server.server.id, item, true);
        commitTree(activeItem.id);
    }

    useEffect(() => {
        const offStart = on(FileDragStartEventKey, (items) => {
            dragItems.current = items as FileStoreItem[];
        });
        const offEnd = on(FileDragEndEventKey, () => {
            dragItems.current = [];
        });
        return () => {
            offStart();
            offEnd();
        };
    }, [on]);

    useEffect(() => {
        if (!editName) return;
        window.setTimeout(() => {
            editNameInputRef.current?.focus({ preventScroll: true });
            editNameInputRef.current?.select();
        }, 0);
    }, [editName]);

    useEffect(() => {
        activeItemRef.current = activeItem;
    }, [activeItem]);

    function openContextMenu(event: React.MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        const offline = server.status !== "connected";
        const menus: MenuItem[] = [
            { label: "刷新", disabled: offline, handler: () => emit(RefreshFileListEventKey) },
            "---",
            { label: "新建文件夹", disabled: offline, handler: () => void createDir() },
            { label: "重命名", disabled: offline || isRoot, handler: () => void rename() },
            { label: "快速删除(rm命令)", disabled: offline || isRoot, handler: () => void remove() },
            "---",
            { label: "复制路径", handler: () => void copyText(item.id) },
            "---",
            {
                label: "下载",
                disabled: offline || isRoot,
                handler: () => {
                    setLoadingText("下载任务生成中...");
                    const promise = addDownloadTask({ sessionId: server.sessionId, serverId: server.server.id }, [item.id]);
                    promise
                        .catch((err) => {
                            console.error(err);
                            showToast("下载任务生成失败", "error");
                        })
                        .finally(() => setLoadingText(""));
                },
            },
            appOsType === "macos"
                ? {
                      label: "上传",
                      disabled: offline,
                      handler: async () => {
                          const paths = await invoke<string[]>("pick_file_or_folder", { title: "上传", multiple: true, defaultPath: await appHomeDir });
                          if (!paths) return;
                          uploadFiles(paths, item);
                      },
                  }
                : {
                      label: "上传",
                      disabled: offline,
                      children: [
                          {
                              label: "上传文件",
                              handler: async () => {
                                  const paths = normalizeDialogPaths(await open({ title: "上传", multiple: true, directory: false, defaultPath: await appHomeDir }));
                                  if (!paths.length) return;
                                  uploadFiles(paths, item);
                              },
                          },
                          {
                              label: "上传文件夹",
                              handler: async () => {
                                  const paths = normalizeDialogPaths(await open({ title: "上传", multiple: true, directory: true, defaultPath: await appHomeDir }));
                                  if (!paths.length) return;
                                  uploadFiles(paths, item);
                              },
                          },
                      ],
                  },
            "---",
            { label: "文件权限…", disabled: offline || isRoot, handler: () => void chmod() },
        ];
        document.body.dispatchEvent(new CustomEvent(CustomMenusEventKey, { bubbles: true, detail: { menus, target: event.nativeEvent } }));
    }

    return (
        <div
            className={`SftpDirTreeItem tree-row${activeItem.id === item.id ? " active" : ""}`}
            data-id={item.id}
            tabIndex={0}
            style={{ paddingLeft: `${item.level * 14 + 8}px` }}
            onClick={clickItem}
            onDoubleClick={() => toggleOpen()}
            onKeyDown={handleRowKeyDown}
            onContextMenu={openContextMenu}
            onDragOver={(event) => {
                if (!dragItems.current.length) return;
                event.preventDefault();
                event.currentTarget.classList.add("drag-over");
            }}
            onDragLeave={(event) => event.currentTarget.classList.remove("drag-over")}
            onDrop={(event) => void dropMovedFiles(event)}
        >
            <button type="button" className="tree-toggle" disabled={leaf || !loaded} onClick={toggleOpen}>
                {item.loading ? (
                    <Icon icon="mdi:loading" className="text-base opacity-80 spin" />
                ) : loaded && !leaf ? (
                    <Icon icon={item.open ? "mdi:chevron-down" : "mdi:chevron-right"} className="text-base opacity-70" />
                ) : null}
            </button>
            <div className="tree-open min-w-0">
                <span className="folder-icon-stack">
                    <Icon icon={icon} className="folder-ic folder-ic-main" />
                    {item.linkPath ? <Icon icon="ion:arrow-redo" className="lnk-corner-ic" aria-hidden="true" /> : null}
                </span>
                {editName === null ? (
                    <span className="tree-name">{item.id === "/" ? "/" : baseName(item.id)}</span>
                ) : (
                    <SystemInput
                        ref={editNameInputRef}
                        value={editName}
                        onChange={setEditName}
                        className="tree-inline-input"
                        onBlur={() => void confirmName(true)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onKeyDown={inputKeyDown}
                    />
                )}
            </div>
        </div>
    );
}
