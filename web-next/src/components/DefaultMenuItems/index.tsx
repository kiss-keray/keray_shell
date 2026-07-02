"use client";

import Icon from "@/components/Icon";
import "./index.scss";

type Divider = "---" | "divider" | { divider: true };
type MenuObj = {
    label: string;
    icon?: string;
    image?: string;
    disabled?: boolean;
    handler?: () => void;
    children?: MenuItem[];
};
export type MenuItem = MenuObj | Divider;

export type DefaultMenuItemsProps = {
    items: MenuItem[];
    onClose?: () => void;
};

function hasChildren(menu: MenuItem) {
    if (typeof menu === "string") return false;
    return "children" in menu && menu.children && menu.children.length > 0;
}

function isDivider(menu: MenuItem) {
    return menu === "---" || menu === "divider" || (typeof menu === "object" && "divider" in menu && menu.divider === true);
}

export default function DefaultMenuItems({ items, onClose }: DefaultMenuItemsProps) {
    function menuClick(menu: MenuItem) {
        if (isDivider(menu)) return;
        const item = menu as MenuObj;
        if (item.disabled) return;
        if (hasChildren(item)) return;
        if (item.handler) item.handler();
        onClose?.();
    }

    return (
        <div className="DefaultMenuItems">
            {items.map((item, i) =>
                isDivider(item) ? (
                    <div key={i} className="menu-divider" role="separator" />
                ) : (
                    <div
                        key={i}
                        className={`item${(item as MenuObj).disabled ? " disabled" : ""}${hasChildren(item) ? " has-submenu" : ""}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            menuClick(item);
                        }}
                    >
                        {(item as MenuObj).image ? <img src={(item as MenuObj).image} className="item-img" alt="" /> : null}
                        {(item as MenuObj).icon ? <Icon icon={(item as MenuObj).icon!} className="item-icon" /> : null}
                        <span className="item-label">{(item as MenuObj).label}</span>
                        {hasChildren(item) ? (
                            <span className="submenu-arrow" aria-hidden="true">
                                ›
                            </span>
                        ) : null}
                        {hasChildren(item) ? (
                            <div className="submenu" onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
                                <DefaultMenuItems items={(item as MenuObj).children!} onClose={onClose} />
                            </div>
                        ) : null}
                    </div>
                ),
            )}
        </div>
    );
}
