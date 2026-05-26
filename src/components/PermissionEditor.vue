<script setup lang="ts">
defineOptions({
    name: "PermissionEditor",
});

type PermRole = "owner" | "group" | "other";
type PermField = "r" | "w" | "x";

const props = withDefaults(
    defineProps<{
        title?: string;
        path?: string;
        modelValue?: number;
        confirmText?: string;
        cancelText?: string;
    }>(),
    {
        title: "修改文件权限",
        path: "",
        modelValue: 0,
        confirmText: "确定",
        cancelText: "取消",
    },
);

const emit = defineEmits<{
    (e: "confirm", value: number): void;
    (e: "cancel"): void;
}>();

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

const permBits = ref(props.modelValue & 0o777);

watch(
    () => props.modelValue,
    (val) => {
        permBits.value = val & 0o777;
    },
);

function isChecked(shift: number, mask: number): boolean {
    return ((permBits.value >> shift) & mask) === mask;
}

function toggle(shift: number, mask: number, checked: boolean) {
    const bit = mask << shift;
    if (checked) permBits.value |= bit;
    else permBits.value &= ~bit;
}

function onConfirm() {
    emit("confirm", permBits.value & 0o777);
}
</script>

<template>
    <div class="perm-mask" @click="emit('cancel')">
        <div class="perm-dialog" role="dialog" aria-modal="true" @click.stop>
            <p class="perm-title">{{ props.title }}</p>
            <p v-if="props.path" class="perm-path">{{ props.path }}</p>
            <table class="perm-table">
                <thead>
                    <tr>
                        <th></th>
                        <th v-for="field in fields" :key="field.key">{{ field.label }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="role in roles" :key="role.key">
                        <th>{{ role.label }}</th>
                        <td v-for="field in fields" :key="field.key">
                            <input
                                type="checkbox"
                                :checked="isChecked(role.shift, field.mask)"
                                @change="toggle(role.shift, field.mask, ($event.target as HTMLInputElement).checked)"
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
            <div class="perm-actions">
                <button type="button" class="perm-btn secondary" @click="emit('cancel')">{{ props.cancelText }}</button>
                <button type="button" class="perm-btn" @click="onConfirm">{{ props.confirmText }}</button>
            </div>
        </div>
    </div>
</template>

<style scoped lang="scss">
.perm-mask {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(2px);
}

.perm-dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 14px 16px;
    border-radius: 10px;
}

.perm-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: 600;
}

.perm-path {
    margin: 6px 0 0;
    word-break: break-all;
}

.perm-table {
    width: 100%;
    margin-top: 10px;
    border-collapse: collapse;

    th,
    td {
        text-align: center;
        padding: 6px 8px;
    }

    thead th {
        border-bottom: 1px solid rgba(255, 255, 255, 0.14);
    }

    tbody th {
        text-align: left;
        font-size: var(--font-size-md);
        font-weight: 500;
        white-space: nowrap;
    }

    tbody td {
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    input[type="checkbox"] {
        width: 15px;
        height: 15px;
    }
}

.perm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
}

.perm-btn {
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 12px;
    cursor: pointer;
}

.perm-btn.secondary {
}
</style>
