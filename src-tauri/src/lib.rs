use crate::app_icon::get_app_icon;
use crate::os::{disable_native_fullscreen, local_fonts, pick_file_or_folder, read_clipboard_text};
use crate::sftp::{
    cat_download_file, download_file, one_read_string, one_write_string, sftp_read,
    sftp_upload_local_file, transfer_cancel, transfer_pause, upload_file,
};
use crate::ssh::{exec_cmd, sync_server_data};
use crate::term::{close_term, open_ssh, ping, resize_pty, write_cmd};
use crate::utils::{open_file_with_app, uuid};
use crate::window_glass::{sync_window_glass, sync_window_transparent};
use tauri::{
    Emitter, Manager, PhysicalSize, TitleBarStyle, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_log::{Target, TargetKind};

mod app_icon;
mod dto;
mod os;
mod sftp;
mod ssh;
mod term;
mod utils;
mod window_glass;

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
            if let WindowEvent::Destroyed { .. } = event {
                let label = window.label().to_string();
                let _ = window
                    .app_handle()
                    .emit("tauri://window-destroyed", label)
                    .map_err(|_| {});
            }
        })
        .setup(|app| {
            let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("")
                .inner_size(1200.0, 800.0)
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
