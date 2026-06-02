#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="keray_shell_rust"
VERSION="$(node -p "require('./package.json').version")"
DMG_DIR="./src-tauri/target/release/bundle/dmg"
APP_PATH="./src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DMG_PATH="${DMG_DIR}/${APP_NAME}_${VERSION}_aarch64.dmg"

pnpm tauri build --bundles app

mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

create-dmg \
  --volname "keray_shell_rust" \
  --window-size 660 500 \
  --icon "keray_shell_rust.app" 180 170 \
  --app-drop-link 480 170 \
  --add-file "安装说明.pdf" "./src-tauri/dmg/安装说明.pdf" 330 300 \
  "$DMG_PATH" \
  "$APP_PATH"