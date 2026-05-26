/**
 * 通道实例提供键
 */
export const ChannelInstanceProvideKey = Symbol("ChannelInstanceProvideKey");

/**
 * 当前激活的文件项
 */
export const SftpActiveItemKey = Symbol("SftpActiveItemKey");

/**
 * 自定义菜单事件
 */
export const CustomMenusEventKey = "CustomMenusEventKey";

/** 设置窗口保存 UI 偏好后广播，主窗口据此重新从磁盘加载 */
export const UiPreferencesSavedEventKey = "keray-ui-preferences-saved";

export const DEFAULT_FONT_FAMILY =
    "Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace, 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft Sans Serif', 'WenQuanYi Micro Hei', sans-serif";
