import { globalIgnores } from "eslint/config";
import { configureVueProject, defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import pluginVue from "eslint-plugin-vue";
import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";

configureVueProject({
    scriptLangs: ["ts", "tsx"],
    rootDir: import.meta.dirname,
});

export default defineConfigWithVueTs(
    {
        name: "app/files-to-lint",
        files: ["**/*.{ts,mts,tsx,vue}"],
    },
    globalIgnores(["**/dist/**", "**/dist-ssr/**", "**/coverage/**", "src-tauri/**"]),
    pluginVue.configs["flat/essential"],
    vueTsConfigs.recommended,
    skipFormatting,
    {
        rules: {
            "vue/multi-word-component-names": [
                "warn",
                {
                    ignores: ["index", "App", "Register", "[id]", "[url]"],
                },
            ],
            "vue/component-name-in-template-casing": [
                "warn",
                "PascalCase",
                {
                    registeredComponentsOnly: false,
                    ignores: ["/^icon-/"],
                },
            ],
            "vue/block-lang": "off",
            semi: ["off", "never"], // 行尾不使用分号
            eqeqeq: 2, // 不需要强制使用全等
            indent: [0, 4], // 强制使用一致的缩进
            quotes: [2, "double", { allowTemplateLiterals: true, avoidEscape: true }], // 字符串使用双引号

            "no-param-reassign": "off",
            radix: "off",
            "no-plusplus": "off",
            "@typescript-eslint/no-shadow": "off",
            "unicorn/prefer-dom-node-text-content": "off",
            "no-implicit-coercion": "off",
            "default-param-last": "off",
            "no-bitwise": "off",
            "no-multi-assign": "off",
            "unicorn/no-new-array": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "no-continue": "off",
            "guard-for-in": "off",
            "no-underscore-dangle": "off",
            "max-params": "off",
            "consistent-return": "off",
            complexity: "off",
            "@typescript-eslint/no-dynamic-delete": "off",
            "@typescript-eslint/ban-ts-comment": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "vue/no-mutating-props": "off",
        },
    },
);
