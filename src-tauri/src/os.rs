use crate::dto::res::Res;
use arboard::Clipboard;
use font_kit::family_name::FamilyName;
use font_kit::font::Font;
use font_kit::properties::Properties;
use font_kit::source::SystemSource;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct LocalFonts {
    default_english_font: String,
    default_chinese_font: String,
    fonts: Vec<LocalFont>,
}

#[derive(Debug, Serialize)]
pub struct LocalFont {
    name: String,
    has_latin: bool,
    has_cjk: bool,
    is_monospace: bool,
}

// 读取剪切板
#[tauri::command]
pub async fn read_clipboard_text() -> Res<String> {
    let mut clipboard = Clipboard::new().unwrap();
    let text = clipboard.get_text().unwrap();
    Res::of(text)
}

// 加载字体列表
#[tauri::command]
pub async fn local_fonts() -> Res<LocalFonts> {
    let source = SystemSource::new();
    let mut families = match source.all_families() {
        Ok(families) => families,
        Err(err) => return Res::fail(format!("读取本地字体列表失败: {err}")),
    };
    families.sort_by_key(|font| font.to_lowercase());
    families.dedup();

    let fonts = families
        .into_iter()
        .map(|name| {
            let (has_latin, has_cjk, is_monospace) = inspect_font_family(&source, &name);
            LocalFont {
                name,
                has_latin,
                has_cjk,
                is_monospace,
            }
        })
        .collect::<Vec<_>>();

    let default_english_font = source
        .select_best_match(&[FamilyName::Monospace], &Properties::new())
        .ok()
        .and_then(|handle| handle.load().ok())
        .map(|font| font.family_name())
        .filter(|font| !font.trim().is_empty())
        .unwrap_or_else(|| "monospace".to_string());
    let default_chinese_font = fonts
        .iter()
        .find(|font| font.has_cjk)
        .map(|font| font.name.clone())
        .unwrap_or_default();

    Res::of(LocalFonts {
        default_english_font,
        default_chinese_font,
        fonts,
    })
}

fn inspect_font_family(source: &SystemSource, family_name: &str) -> (bool, bool, bool) {
    let family = match source.select_family_by_name(family_name) {
        Ok(family) => family,
        Err(_) => return (false, false, false),
    };

    let mut has_latin = false;
    let mut has_cjk = false;
    let mut is_monospace = false;

    for handle in family.fonts().iter().take(4) {
        let Ok(font) = handle.load() else {
            continue;
        };
        has_latin |= has_all_chars(&font, &['A', 'a', '0']);
        has_cjk |= has_any_char(&font, &['中', '国', '汉', '你']);
        is_monospace |= font.is_monospace();
        if has_latin && has_cjk && is_monospace {
            break;
        }
    }

    (has_latin, has_cjk, is_monospace)
}

fn has_all_chars(font: &Font, chars: &[char]) -> bool {
    chars.iter().all(|ch| font.glyph_for_char(*ch).is_some())
}

fn has_any_char(font: &Font, chars: &[char]) -> bool {
    chars.iter().any(|ch| font.glyph_for_char(*ch).is_some())
}




// mac端弹窗选择文件或者文件夹
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn pick_file_or_folder(
    title: Option<String>,
    default_path: Option<String>,
    multiple: Option<bool>,
) -> Res<Vec<String>> {
    use rfd::AsyncFileDialog;
    let mut dlg = AsyncFileDialog::new();
    if let Some(t) = title {
        dlg = dlg.set_title(t);
    }
    if let Some(dir) = default_path {
        dlg = dlg.set_directory(dir);
    }
    if multiple.unwrap_or(false) {
        let hds = dlg.pick_files_or_folders().await;
        if let Some(hds) = hds {
            return Res::of(
                hds.into_iter()
                    .map(|path| path.path().to_string_lossy().into_owned())
                    .collect(),
            );
        }
        Res::ok()
    } else {
        let hd = dlg.pick_file_or_folder().await;
        if let Some(hd) = hd {
            return Res::of(vec![hd.path().to_string_lossy().into_owned()]);
        }
        Res::ok()
    }
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn pick_file_or_folder() -> Res<Vec<String>> {
    Res::ok()
}
