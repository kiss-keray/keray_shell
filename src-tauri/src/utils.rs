use crate::dto::res::Res;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[tauri::command]
pub async fn uuid() -> Res<String> {
    Res::of(Uuid::new_v4().to_string())
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tauri::command]
pub fn open_file_with_app(app_path: String, file_path: String) -> Res<()> {
  let result = if cfg!(target_os = "macos") {
      std::process::Command::new("open")
          .arg("-a")
          .arg(app_path)
          .arg(file_path)
          .spawn()
  } else {
      std::process::Command::new(app_path)
          .arg(file_path)
          .spawn()
  };
  match result {
      Ok(_) => Res::ok(),
      Err(e) => {
          println!("{}", e);
          Res::fail("Failed to open file")
      }
  }
}