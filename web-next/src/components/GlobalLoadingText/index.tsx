"use client";

import { createPortal } from "react-dom";
import Icon from "@/components/Icon";
import { useAppStore } from "@/stores/app";
import "./index.scss";

export default function GlobalLoadingText() {
    const loadingText = useAppStore((state) => state.loadingText);
    if (!loadingText || typeof document === "undefined") return null;
    return createPortal(
        <div className="GlobalLoadingText loading-mask">
            <div className="loading-content">
                <div className="loading-icon-wrap">
                    <Icon icon="mdi:loading" className="loading-icon" />
                </div>
                <div className="loading-text-wrap">
                    <p className="loading-text">{loadingText}</p>
                </div>
            </div>
        </div>,
        document.body,
    );
}
