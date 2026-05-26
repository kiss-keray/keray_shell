<script setup lang="ts">
defineOptions({ name: "DefaultMenuItems" });

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

defineProps({
    items: {
        type: Array as PropType<MenuItem[]>,
        required: true,
    },
});

const emit = defineEmits(["close"]);

function hasChildren(menu: MenuItem) {
    if (typeof menu === "string") return false;
    return "children" in menu && menu.children && menu.children.length > 0;
}

function isDivider(menu: MenuItem) {
    return menu === "---" || menu === "divider" || ("divider" in menu && menu.divider === true);
}

function menuClick(menu: MenuItem) {
    if (isDivider(menu)) return;
    menu = menu as MenuObj;
    if (menu.disabled) return;
    if (hasChildren(menu)) return;
    if (menu.handler) menu.handler();
    emit("close");
}
</script>

<template>
    <template v-for="(item, i) in items" :key="i">
        <div v-if="isDivider(item)" class="menu-divider" role="separator" />
        <div v-else class="item" :class="{ disabled: (item as MenuObj).disabled, 'has-submenu': hasChildren(item) }" @click.stop="menuClick(item)">
            <img v-if="(item as MenuObj).image" :src="(item as MenuObj).image" class="item-img" />
            <Icon v-if="(item as MenuObj).icon" :icon="(item as MenuObj).icon!" class="item-icon" />
            <span class="item-label">{{ (item as MenuObj).label }}</span>
            <span v-if="hasChildren(item)" class="submenu-arrow" aria-hidden="true">›</span>
            <div v-if="hasChildren(item)" class="submenu" @mousedown.stop @contextmenu.prevent>
                <DefaultMenuItems :items="(item as MenuObj).children!" @close="emit('close')" />
            </div>
        </div>
    </template>
</template>

<style scoped lang="scss">
.menu-divider {
    height: 1px;
    margin: 4px 8px;
}

.item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 6px 14px;
    cursor: pointer;
    justify-content: flex-start;
    white-space: nowrap;

    &:hover:not(.disabled) {
    }

    &.disabled {
        cursor: default;
    }
    .item-img,
    .item-icon {
        font-size: var(--font-size-2xl);
        width: var(--font-size-2xl);
        height: var(--font-size-2xl);
        border-radius: 4px;
        object-fit: cover;
    }
}

.item-label {
    overflow: hidden;
    text-overflow: ellipsis;
}

.submenu-arrow {
    font-size: var(--font-size-lg);
    line-height: 1;
    margin-left: 6px;
    flex-shrink: 0;
}

.submenu {
    display: none;
    position: absolute;
    top: -5px;
    left: calc(100% - 2px);
    min-width: 150px;
    max-width: min(320px, calc(100vw - 16px));
    padding: 4px 0;
    border-radius: 6px;
    z-index: 1;
}

.item.has-submenu:hover:not(.disabled) > .submenu {
    display: block;
}
</style>
