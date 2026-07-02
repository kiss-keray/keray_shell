"use client";

import { Icon as IconifyIcon, type IconProps } from "@iconify/react";
import "./index.scss";

export type AppIconProps = IconProps & {
    icon?: string;
};

export default function Icon({ icon, className, ...attrs }: AppIconProps) {
    return <IconifyIcon icon={icon!} {...attrs} className={className ? `Icon ${className}` : "Icon"} />;
}
