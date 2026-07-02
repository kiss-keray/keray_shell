"use client";

import "./index.scss";

/** 编辑器 Tab 项（由 MonacoWin 传入） */
export type MonacoTabItem = {
    key: string;
    title: string;
    dirty: boolean;
    loading: boolean;
    saving: boolean;
};

export type MonacoEditorTabsProps = {
    tabs: MonacoTabItem[];
    activeKey: string;
    onSelect: (key: string) => void;
    onClose: (key: string) => void;
};

export default function MonacoEditorTabs({ tabs, activeKey, onSelect, onClose }: MonacoEditorTabsProps) {
    function close(e: React.MouseEvent, key: string) {
        e.preventDefault();
        e.stopPropagation();
        onClose(key);
    }

    /** 中键关闭（编辑器常见交互） */
    function auxClick(e: React.MouseEvent, key: string) {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        onClose(key);
    }

    return (
        <div className="MonacoEditorTabs monaco-tabs">
            <div className="monaco-tabs-scroll">
                {tabs.map((tab) => (
                    <div
                        key={tab.key}
                        role="tab"
                        tabIndex={0}
                        className={`monaco-tab${tab.key === activeKey ? " active" : ""}${tab.dirty ? " dirty" : ""}${tab.loading ? " loading" : ""}${tab.saving ? " saving" : ""}`}
                        aria-selected={tab.key === activeKey}
                        onClick={() => tab.key !== activeKey && onSelect(tab.key)}
                        onAuxClick={(event) => auxClick(event, tab.key)}
                        onKeyDown={(event) => event.key === "Enter" && onSelect(tab.key)}
                    >
                        <span className="monaco-tab-title">{tab.title}</span>
                        {tab.loading ? <span className="monaco-tab-badge">↓</span> : null}
                        {!tab.loading && tab.saving ? <span className="monaco-tab-badge">↑</span> : null}
                        {!tab.loading && !tab.saving && tab.dirty ? (
                            <span className="monaco-tab-dot" aria-hidden="true">
                                •
                            </span>
                        ) : null}
                        <button type="button" className="monaco-tab-close" aria-label="关闭" onClick={(event) => close(event, tab.key)}>
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
