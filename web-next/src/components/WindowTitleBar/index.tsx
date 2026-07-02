"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.scss";

export default function WindowTitleBar() {
    async function onClose() {
        await getCurrentWindow().close();
    }

    async function onMinimize() {
        await getCurrentWindow().minimize();
    }

    async function onToggleMaximize() {
        await getCurrentWindow().toggleMaximize();
    }

    return (
        <div className="WindowTitleBar window-title-bar">
            <div className="traffic-lights">
                <button type="button" className="traffic close" title="关闭" aria-label="关闭" onClick={() => void onClose()} />
                <button type="button" className="traffic minimize" title="最小化" aria-label="最小化" onClick={() => void onMinimize()} />
                <button type="button" className="traffic maximize" title="最大化" aria-label="最大化" onClick={() => void onToggleMaximize()} />
            </div>
        </div>
    );
}
