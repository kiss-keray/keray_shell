"use client";

import { useEffect, useRef, useState } from "react";
import DefaultMenuItems, { type MenuItem } from "@/components/DefaultMenuItems";
import "./index.scss";

export type DefaultMenusProps = {
    menus: MenuItem[];
    pos: { x: number; y: number };
    onClose?: () => void;
};

function buildMenuMeasureKey(items: MenuItem[]): string {
    // Vue 版对 menus 使用 deep watch；这里递归提取会影响菜单尺寸/结构的字段来触发重新测量。
    return items
        .map((item) => {
            if (typeof item === "string") return item;
            if (!("label" in item)) return "divider:true";
            const children = "children" in item && item.children ? buildMenuMeasureKey(item.children) : "";
            return [item.label, item.icon ?? "", item.image ?? "", item.disabled ? "1" : "0", children].join("\u0001");
        })
        .join("\u0002");
}

export default function DefaultMenus({ menus, pos, onClose }: DefaultMenusProps) {
    const root = useRef<HTMLDivElement>(null);
    const [domPosition, setDomPosition] = useState({ x: -9999, y: -9999 });
    const menuMeasureKey = buildMenuMeasureKey(menus);

    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            const el = root.current;
            if (!el) return;
            const { width, height } = el.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const pad = 8;
            const maxX = vw - width - pad;
            const maxY = vh - height - pad;
            let x = pos.x + 10;
            let y = Math.min(pos.y, maxY);
            if (x > maxX) x = pos.x - width;
            x = Math.max(pad, Math.min(x, maxX));
            y = Math.max(pad, Math.min(y, maxY));
            setDomPosition({ x, y });
        });
        return () => cancelAnimationFrame(frame);
    }, [menuMeasureKey, pos]);

    return (
        <div className="DefaultMenus menu-box">
            <div
                ref={root}
                className="menu-module"
                style={{ left: `${domPosition.x}px`, top: `${domPosition.y}px` }}
                onMouseDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
            >
                <DefaultMenuItems items={menus} onClose={onClose} />
            </div>
        </div>
    );
}
