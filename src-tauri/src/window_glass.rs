#[cfg(target_os = "macos")]
use cocoa::appkit::CGFloat;
use tauri::{utils::config::Color, WebviewWindow};

#[tauri::command]
pub fn sync_window_transparent(
    window: WebviewWindow,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) -> Result<(), String> {
    set_window_transparent(&window, r, g, b, a).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_window_glass(window: WebviewWindow, enabled: bool, dark: bool) -> Result<(), String> {
    if enabled {
        apply_glass(&window, dark).map_err(|e| e.to_string())
    } else {
        clear_glass(&window).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
fn set_macos_appearance(
    window: &WebviewWindow,
    dark: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use cocoa::appkit::{
        NSAppearance, NSAppearanceNameVibrantDark, NSAppearanceNameVibrantLight, NSWindow,
    };
    use cocoa::base::id;

    let ns_window = window.ns_window()? as id;
    unsafe {
        let name = if dark {
            NSAppearanceNameVibrantDark
        } else {
            NSAppearanceNameVibrantLight
        };
        let appearance = NSAppearance(name);
        ns_window.setAppearance(appearance);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_glass(window: &WebviewWindow, dark: bool) -> Result<(), Box<dyn std::error::Error>> {
    use window_vibrancy::{
        apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
    };

    let _ = clear_vibrancy(window);
    set_macos_appearance(window, dark)?;
    apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        None,
    )?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_glass(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    use window_vibrancy::clear_vibrancy;
    let _ = clear_vibrancy(window)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_glass(window: &WebviewWindow, dark: bool) -> Result<(), Box<dyn std::error::Error>> {
    use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};

    let _ = clear_mica(window);
    let _ = clear_acrylic(window);
    if apply_mica(window, Some(dark)).is_ok() {
        return Ok(());
    }
    let tint = if dark {
        (18u8, 18, 18, 125)
    } else {
        (242u8, 242, 242, 200)
    };
    apply_acrylic(window, Some(tint))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn clear_glass(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    use window_vibrancy::{clear_acrylic, clear_mica};
    let _ = clear_mica(window);
    let _ = clear_acrylic(window);
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply_glass(_window: &WebviewWindow, _dark: bool) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn clear_glass(_window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

fn set_window_transparent(
    window: &WebviewWindow,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    set_macos_window_transparent(window, r, g, b, a)?;
    let _ = window.set_background_color(Some(Color(r, g, b, a)));
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_macos_window_transparent(
    window: &WebviewWindow,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) -> Result<(), Box<dyn std::error::Error>> {
    use cocoa::appkit::{NSColor, NSWindow};
    use cocoa::base::{id, nil, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CString;
    let transparent = a.clone() == 0;

    let ns_window = window.ns_window()? as id;
    unsafe {
        ns_window.setOpaque_(if transparent { NO } else { YES });
        let color = if transparent {
            NSColor::clearColor(nil)
        } else {
            NSColor::colorWithRed_green_blue_alpha_(
                nil,
                r as CGFloat / 255.0,
                g as CGFloat / 255.0,
                b as CGFloat / 255.0,
                a as CGFloat / 255.0,
            )
        };
        ns_window.setBackgroundColor_(color);
    }

    window.with_webview(move |wv| {
        let webview = wv.inner() as id;
        unsafe {
            let key_c = CString::new("drawsBackground").expect("key");
            let key: id = msg_send![class!(NSString), stringWithUTF8String: key_c.as_ptr()];
            let draws = if transparent { NO } else { YES };
            let num: id = msg_send![class!(NSNumber), numberWithBool: draws];
            let _: () = msg_send![webview, setValue: num forKey: key];
            webview.setOpaque_(if transparent { NO } else { YES });
        }
    })?;
    Ok(())
}

