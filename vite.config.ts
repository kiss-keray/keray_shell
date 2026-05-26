import { fileURLToPath, URL } from "node:url"

import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import vueJsx from "@vitejs/plugin-vue-jsx"
import vueDevTools from "vite-plugin-vue-devtools"
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import Icons from "unplugin-icons/vite";
import IconsResolver from "unplugin-icons/resolver";
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        vue(),
        vueJsx(),
        vueDevTools(),
        AutoImport({
            imports: ["vue", "vue-router"],
            dirs: ["src/utils", "src/stores"],
            include: [/\.[tj]s$/, /\.vue$/, /\.vue\?vue/]
        }),
        Components({
            globalNamespaces: ["global"],
            types: [{ from: "vue-router", names: ["RouterLink", "RouterView"] }],
            resolvers: [IconsResolver()], dirs: [
                "src/components",
                "src/layout",
            ],
            deep: true
        }),
        // https://icon-sets.iconify.design/
        Icons({
            compiler: "vue3",
            customCollections: {},
            scale: 1,
            defaultClass: "inline-block",
            autoInstall: true
        }),
        tailwindcss(),
    ],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            "@ssh": fileURLToPath(new URL("./src/components/ssh", import.meta.url)),
        },
    },
    server: {
        port: 1420,
        strictPort: true,
        watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"]
        }
    },
})
