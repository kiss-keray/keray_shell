#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = process.argv[2]

if (!version) {
    console.error("Usage: pnpm set-version <version>")
    process.exit(1)
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`Invalid semver version: ${version}`)
    process.exit(1)
}

const packageJsonPath = join(root, "package.json")
const cargoTomlPath = join(root, "src-tauri", "Cargo.toml")
const tauriConfPath = join(root, "src-tauri", "tauri.conf.json")

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
packageJson.version = version
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

const cargoToml = readFileSync(cargoTomlPath, "utf8")
writeFileSync(
    cargoTomlPath,
    cargoToml.replace(
        /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
        `$1"${version}"`,
    ),
)

const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"))
tauriConf.version = version
writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`)

execFileSync("cargo", ["update", "-p", packageJson.name, "--precise", version], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
})

console.log(`Version updated to ${version}`)
