"use client";

import { createContext, useContext } from "react";
import type { ChannelInstance } from "@/stores/channelInstances";
import type { FileStoreItem } from "@/components/sftp/model";

export type SftpContextValue = {
    server: ChannelInstance;
    writeTerminal?: (value: string) => void;
    rootFile: FileStoreItem;
    activeItem: FileStoreItem;
    setActiveItem: (item: FileStoreItem) => void;
    refreshTree: () => void;
};

export const SftpContext = createContext<SftpContextValue | null>(null);

export function useSftpContext(): SftpContextValue {
    const value = useContext(SftpContext);
    if (!value) throw new Error("useSftpContext must be used inside SftpContext.Provider");
    return value;
}
