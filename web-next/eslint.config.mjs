import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
    {
        ignores: [".next/**", "out/**"],
    },
    ...nextVitals,
    ...nextTs,
    {
        rules: {
            // 迁移底座大量复用 Vue 版工具代码，先保留既有注释和 any 形态，后续业务组件迁移时再逐步收紧。
            "@typescript-eslint/ban-ts-comment": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@next/next/no-img-element": "off",
            // useEffect/useCallback 等 Hook 读取 state、props 或闭包变量时，必须显式写入依赖数组，避免闭包里拿到过期值。
            "react-hooks/exhaustive-deps": "error",
            // React 19 编译器规则对部分受控弹窗同步 props 的迁移写法过严，当前阶段以行为对齐为先。
            "react-hooks/set-state-in-effect": "off",
            "react-hooks/refs": "off",
            "react-hooks/immutability": "off",
            "react-hooks/static-components": "off",
        },
    },
    {
        rules: {
            "eqeqeq": "error",
        }
    }
];

export default eslintConfig;
