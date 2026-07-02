"use client";

import { useEffect, useState } from "react";
import SettingDialog from "@/components/SettingDialog";
import type { SettingsTab } from "@/types/settings";
import "./index.scss";

export default function SettingWin() {
    const [activeTab, setActiveTab] = useState<SettingsTab>("general");

    useEffect(() => {
        document.body.classList.add("setting-window");
        const params = new URLSearchParams(location.search);
        setActiveTab((params.get("tab") as SettingsTab) || "general");
        return () => document.body.classList.remove("setting-window");
    }, []);

    return (
        <main className="SettingWin">
            <SettingDialog activeTab={activeTab} onActiveTabChange={setActiveTab} />
        </main>
    );
}
