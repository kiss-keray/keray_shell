use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tauri::{App, Manager, Runtime};

/// 将当前版本随应用发布的 Agent 文件同步到 appDataDir。
///
/// builtin 完全由应用管理，因此版本变化时整体替换；
/// custom 是用户目录，不参与同步，避免升级时丢失用户文件。
pub fn prepare_agents_dir<R: Runtime>(app: &App<R>) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let source_dir = app.path().resource_dir()?.join("agents");
    let agents_root = app.path().app_data_dir()?.join("agents");
    let builtin_dir = agents_root.join("builtin");
    let custom_dir = agents_root.join("custom");
    let version_file = agents_root.join(".builtin-version");
    let bundled_version = app.package_info().version.to_string();

    if !source_dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("安装包中找不到 agents 资源目录: {}", source_dir.display()),
        )
        .into());
    }

    fs::create_dir_all(&agents_root)?;
    fs::create_dir_all(&custom_dir)?;

    let installed_version = fs::read_to_string(&version_file)
        .ok()
        .map(|value| value.trim().to_string());

    if installed_version.as_deref() != Some(bundled_version.as_str()) {
        // builtin 是应用托管目录。整体替换可以同时处理文件更新、
        // 新增和删除，避免旧版本已经废弃的提示词继续生效。
        if builtin_dir.exists() {
            fs::remove_dir_all(&builtin_dir)?;
        }

        copy_dir_all(&source_dir, &builtin_dir)?;
        fs::write(&version_file, format!("{bundled_version}\n"))?;
    }

    Ok(agents_root)
}

/// 递归复制整个目录，并覆盖目标中的同名文件。
fn copy_dir_all(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        if entry.file_type()?.is_dir() {
            copy_dir_all(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path)?;
        }
    }

    Ok(())
}
