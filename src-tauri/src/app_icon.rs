use crate::dto::res::Res;
use base64::{engine::general_purpose::STANDARD, Engine as _};

/// 返回 `data:image/png;base64,...`，可直接用于 `<img :src="...">`
#[tauri::command]
pub fn get_app_icon(app_path: String) -> Res<String> {
    match app_icon_data_url(&app_path) {
        Ok(url) => Res::of(url),
        Err(e) => Res::fail(e),
    }
}

fn app_icon_data_url(app_path: &str) -> Result<String, String> {
    if app_path.trim().is_empty() {
        return Err("应用路径为空".into());
    }

    #[cfg(target_os = "macos")]
    return macos_app_icon(app_path).map_err(|e| e.to_string());

    #[cfg(target_os = "windows")]
    return windows_app_icon(app_path).map_err(|e| e.to_string());

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("当前平台暂不支持获取应用图标".into())
}

#[cfg(target_os = "macos")]
fn macos_app_icon(app_path: &str) -> anyhow::Result<String> {
    use cocoa::appkit::NSImage;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSSize, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    const ICON_SIZE: f64 = 32.0;
    /// NSBitmapImageFileTypePNG
    const NS_BITMAP_IMAGE_FILE_TYPE_PNG: usize = 4;

    unsafe {
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let ns_path = NSString::alloc(nil).init_str(app_path);
        let icon: id = msg_send![workspace, iconForFile: ns_path];
        if icon == nil {
            anyhow::bail!("无法获取应用图标: {app_path}");
        }

        let size = NSSize::new(ICON_SIZE, ICON_SIZE);
        let _: () = msg_send![icon, setSize: size];

        let tiff: id = icon.TIFFRepresentation();
        if tiff == nil {
            anyhow::bail!("图标 TIFF 数据为空");
        }

        // 用 AppKit 转 PNG，避免 image crate 无法解码 macOS 16-bit float TIFF
        let bitmap_rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        if bitmap_rep == nil {
            anyhow::bail!("无法解析图标位图");
        }

        let png_data: id = msg_send![
            bitmap_rep,
            representationUsingType: NS_BITMAP_IMAGE_FILE_TYPE_PNG
            properties: nil
        ];
        if png_data == nil {
            anyhow::bail!("图标 PNG 编码失败");
        }

        let length: usize = msg_send![png_data, length];
        let ptr: *const u8 = msg_send![png_data, bytes];
        if ptr.is_null() || length == 0 {
            anyhow::bail!("图标 PNG 字节为空");
        }
        let png_bytes = std::slice::from_raw_parts(ptr, length);

        let b64 = STANDARD.encode(png_bytes);
        Ok(format!("data:image/png;base64,{b64}"))
    }
}

#[cfg(target_os = "windows")]
fn windows_app_icon(app_path: &str) -> anyhow::Result<String> {
    use std::path::Path;

    let b64 = windows_icons::get_icon_base64_by_path(Path::new(app_path))
        .map_err(|e| anyhow::anyhow!("无法获取应用图标: {app_path} ({e})"))?;
    Ok(format!("data:image/png;base64,{b64}"))
}
