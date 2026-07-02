"use client";

import { useEffect, useRef } from "react";
import type React from "react";
import { useSftpContext } from "@/components/sftp/context";
import { compareNameLikeExplorer, type FileStoreItem } from "@/components/sftp/model";
import SftpDirTreeItem from "@/components/sftp/SftpDirTreeItem";
import { dragListener } from "@/utils/project";
import "./index.scss";
import { useAsyncUnlisten } from "@/hooks/useAsyncUnlisten";
import { awaiting } from "@/utils";

export type SftpDirTreeProps = {
    width: number;
};

function renderTreeRows(root: FileStoreItem): React.ReactNode[] {
    const rows: React.ReactNode[] = [];
    const walk = (item: FileStoreItem) => {
        if (!item.isDir) return;
        rows.push(<SftpDirTreeItem key={item.id} item={item} />);
        if (!item.open || !item.children) return;
        // 目录树子项顺序跟随 Vue 版 showChildren，避免远端返回顺序影响展示。
        item.children
            .filter((child) => child.isDir)
            .sort((a, b) => compareNameLikeExplorer(a.id, b.id))
            .forEach(walk);
    };
    walk(root);
    return rows;
}

export default function SftpDirTree({ width }: SftpDirTreeProps) {
    const { server, rootFile, activeItem, refreshTree } = useSftpContext();
    const treeRootRef = useRef<HTMLDivElement | null>(null);
    const lastAutoScrollActiveIdRef = useRef<string | null>(null);

    useEffect(() => {
        server.snapshotFn.sftpTree = () => ({ treePanelScrollTop: treeRootRef.current?.scrollTop ?? 0 });
        const snapshot = server.snapshot.sftpTree as { treePanelScrollTop?: number } | undefined;
        if (snapshot && treeRootRef.current) {
            delete server.snapshot.sftpTree;
            treeRootRef.current.scrollTop = snapshot.treePanelScrollTop ?? 0;
        }
    }, [server]);

    useAsyncUnlisten(() => dragListener(() => Array.from(treeRootRef.current?.querySelectorAll<HTMLElement>(".tree-row") ?? [])), []);

    useEffect(() => {
        if (lastAutoScrollActiveIdRef.current === activeItem.id) return;
        lastAutoScrollActiveIdRef.current = activeItem.id;
        let changed = false;
        for (let parent = activeItem.parent; parent; parent = parent.parent) {
            if (!parent.open) {
                parent.open = true;
                changed = true;
            }
        }
        if (changed) refreshTree();
        window.setTimeout(async () => {
            const root = treeRootRef.current;
            if (!root) return;
            let row: HTMLElement | null = null;
            await awaiting(() => {
                row = root.querySelector<HTMLElement>(`.tree-row[data-id="${CSS.escape(activeItem.id)}"]`);
                return row !== null;
            });
            const rowRect = row!.getBoundingClientRect();
            const rootRect = root.getBoundingClientRect();
            const rowHeight = rowRect.height || 26;
            const itemTop = rowRect.top - rootRect.top + root.scrollTop;
            if (itemTop < root.scrollTop) {
                root.scrollTop = itemTop - rowHeight;
            } else if (itemTop + rowHeight > root.scrollTop + root.clientHeight) {
                root.scrollTop = itemTop - root.clientHeight + rowHeight * 2;
            }
        });
    }, [activeItem, refreshTree]);

    return (
        <div className="SftpDirTree tree-root" ref={treeRootRef} style={{ width: `${width}px` }}>
            {renderTreeRows(rootFile)}
        </div>
    );
}
