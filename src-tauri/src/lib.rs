use crate::app_icon::get_app_icon;
use crate::os::{
    disable_native_fullscreen, local_fonts, pick_file_or_folder, read_clipboard_image,
    read_clipboard_text,
};
use crate::sftp::{
    cat_download_file, download_file, one_read_string, one_write_string, sftp_read,
    sftp_upload_local_file, transfer_cancel, transfer_pause, upload_file,
};
use crate::ssh::{cancel_exec_cmd, exec_cmd, sync_server_data};
use crate::term::{close_term, open_ssh, ping, resize_pty, write_cmd};
use crate::utils::{open_file_with_app, uuid};
use crate::window_glass::{sync_window_glass, sync_window_transparent};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalSize, Runtime, TitleBarStyle, WebviewUrl,
    WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_log::{Target, TargetKind};
mod agent_resources;
mod app_icon;
mod dto;
mod os;
mod sftp;
mod ssh;
mod term;
mod utils;
mod window_glass;
mod channel;

const MAIN_WINDOW_LABEL: &str = "main";
const MAIN_WINDOW_SIZE_FILE: &str = "main-window-size.json";

/// 需要持久化的窗口尺寸；主窗口首次启动时仍使用原有默认大小。
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
struct SavedWindowSize {
    width: f64,
    height: f64,
}

impl Default for SavedWindowSize {
    fn default() -> Self {
        Self {
            width: 1500.0,
            height: 1000.0,
        }
    }
}

impl SavedWindowSize {
    /// 拒绝异常缓存，避免损坏的 JSON 把窗口恢复成不可见尺寸。
    fn is_valid(self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }
}

/// 仅主窗口和 child-* 窗口需要持久化；所有 child-* 窗口共享最近一次保存的尺寸。
fn window_size_file(label: &str) -> Option<&'static str> {
    if label == MAIN_WINDOW_LABEL || label.starts_with("main-") {
        Some(MAIN_WINDOW_SIZE_FILE)
    } else {
        None
    }
}

/// 尺寸文件放在应用数据目录，避免依赖页面加载完成后再调整窗口造成闪烁。
fn window_size_path<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<Option<PathBuf>, tauri::Error> {
    let Some(file) = window_size_file(label) else {
        return Ok(None);
    };
    Ok(Some(app.path().app_data_dir()?.join(file)))
}

/// 读取指定窗口类型上次保存的逻辑像素尺寸；缓存不存在或损坏时返回 None。
fn read_saved_window_size<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<SavedWindowSize> {
    let size = window_size_path(app, label)
        .ok()
        .flatten()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str::<SavedWindowSize>(&content).ok());

    size.filter(|size| size.is_valid())
}

/// 保存缩放事件携带的内部尺寸，并换算成逻辑像素以兼容不同系统缩放比例。
fn save_window_size<R: Runtime>(window: &Window<R>, physical_size: PhysicalSize<u32>) {
    let size = window.scale_factor().map(|scale_factor| {
        let logical_size = physical_size.to_logical::<f64>(scale_factor);
        SavedWindowSize {
            width: logical_size.width,
            height: logical_size.height,
        }
    });
    let Ok(size) = size else {
        log::warn!("读取窗口缩放比例失败，本次尺寸变化不更新缓存");
        return;
    };
    if !size.is_valid() {
        log::warn!("窗口尺寸异常，本次尺寸变化不更新缓存");
        return;
    }

    let save_result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let Some(path) = window_size_path(window.app_handle(), window.label())? else {
            return Ok(());
        };
        // 应用数据目录在首次启动时可能尚未存在，写文件前必须先创建。
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_vec(&size)?)?;
        Ok(())
    })();

    if let Err(error) = save_result {
        // 写盘失败不能影响窗口缩放，只记录原因供排查。
        log::warn!("保存窗口尺寸失败: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // 服务器相关
            sync_server_data,
            // 命令相关
            exec_cmd,
            cancel_exec_cmd,
            // 终端相关
            open_ssh,
            write_cmd,
            resize_pty,
            ping,
            close_term,
            // 工具类
            uuid,
            open_file_with_app,
            get_app_icon,
            // sftp相关
            transfer_pause,
            transfer_cancel,
            cat_download_file,
            download_file,
            upload_file,
            sftp_read,
            sftp_upload_local_file,
            one_read_string,
            one_write_string,
            // os相关
            pick_file_or_folder,
            read_clipboard_text,
            read_clipboard_image,
            local_fonts,
            sync_window_glass,
            sync_window_transparent,
            disable_native_fullscreen
        ])
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { .. } => {
                    if window_size_file(window.label()).is_some() {
                        let physical_size = window.inner_size().unwrap();
                        // 全屏产生的尺寸变化不能覆盖最后一次普通窗口尺寸。
                        if matches!(window.is_fullscreen(), Ok(false)) {
                            save_window_size(window, physical_size);
                        }
                    }
                }
                WindowEvent::Destroyed { .. } => {
                    let label = window.label().to_string();
                    let _ = window
                        .app_handle()
                        .emit("tauri://window-destroyed", label)
                        .map_err(|_| {});
                }
                _ => {}
            }
        })
        .setup(|app| {
            // setup 阶段已经持有 App，且发生在主窗口创建之前，适合准备前端依赖的 Agent 资源。
            let agents_dir = agent_resources::prepare_agents_dir(app)?;
            log::info!("Agent 提示词目录初始化完成: {}", agents_dir.display());

            // 在创建窗口前读取尺寸，确保首帧就使用上次退出时的宽高。
            let main_window_size =
                read_saved_window_size(app.handle(), MAIN_WINDOW_LABEL).unwrap_or_default();
            let win_builder =
                WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::default())
                    .title("")
                    .inner_size(main_window_size.width, main_window_size.height)
                    .transparent(false)
                    .prevent_overflow_with_margin(PhysicalSize::new(0, 0))
                    .center();

            #[cfg(target_os = "macos")]
            let win_builder = win_builder
                .decorations(true)
                .title_bar_style(TitleBarStyle::Overlay);
            #[cfg(not(target_os = "macos"))]
            let win_builder = win_builder.decorations(false);
            let _ = win_builder.build().unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
