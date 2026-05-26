use crate::dto::res::Res;
use crate::ssh::server_get_channel;
use crate::utils::now;
use getset::{Getters, Setters};
use log::{debug, info};
use once_cell::sync::Lazy;
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};
use serde_json::Value::Null;
use serde_json::{from_value, to_value, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc::Sender;
use tokio::sync::RwLock;
use tokio::time::sleep;

struct SessionStore {
    time: u64,
    sender: Sender<(u32, Value)>,
    reader: tauri::ipc::Channel<Vec<u8>>,
}
impl SessionStore {
    async fn close(&self) {
        let _ = self.sender.send((2, Null)).await;
    }
}

#[derive(Debug, Serialize, Deserialize, Getters, Setters, Default, Clone)]
#[getset(get = "pub", set = "pub")]
pub struct PtyParam {
    term: String,
    col_width: u32,
    row_height: u32,
    pix_width: u32,
    pix_height: u32,
}

static SESSION_STORE: Lazy<RwLock<HashMap<String /*sid*/, SessionStore>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

static TIME_HANDLER: Lazy<String> = Lazy::new(|| {
    tokio::spawn(async {
        let secs = 30;
        let is_expire = |time: u64, timestamp: u64, secs: u64| -> bool {
            return time + secs < timestamp;
        };
        loop {
            sleep(Duration::from_secs(secs)).await;
            let timestamp = now();
            let mut remove_keys: Vec<String> = vec![];
            for (id, session_store) in SESSION_STORE.read().await.iter() {
                if is_expire(session_store.time, timestamp, secs) {
                    session_store.close().await;
                    remove_keys.push(id.clone());
                    info!("session已关闭:{}", id);
                }
            }
            if !remove_keys.is_empty() {
                let mut map = SESSION_STORE.write().await;
                for id in remove_keys {
                    map.remove(&id);
                }
            }
        }
    });
    now().to_string()
});

// 关闭终端
#[tauri::command]
pub async fn close_term(sid: String) -> Res<()> {
    let map = SESSION_STORE.read().await;
    let session = map.get(&sid);
    if let Some(session) = session {
        session.close().await;
    }
    Res::ok()
}

#[tauri::command]
pub async fn ping(sid: String) -> Res<()> {
    write_ssh(sid, 3u32, Null).await
}

async fn write_ssh(sid: String, tp: u32, val: Value) -> Res<()> {
    let map = SESSION_STORE.read().await;
    let session = map.get(&sid);
    if session.is_none() {
        return Res::fail("连接已断开");
    }
    let session = session.unwrap();
    let _ = session.sender.send((tp, val)).await;
    Res::ok()
}

// 终端session输入
#[tauri::command]
pub async fn write_cmd(sid: String, cmd: String) -> Res<()> {
    write_ssh(sid, 0u32, to_value(cmd).unwrap()).await
}
// 终端session修改resize
#[tauri::command]
pub async fn resize_pty(sid: String, pty: PtyParam) -> Res<()> {
    write_ssh(sid, 1u32, to_value(pty).unwrap()).await
}

// 打开终端
#[tauri::command]
pub async fn open_ssh(
    server_id: String,
    sid: String, // sessionId
    reader: tauri::ipc::Channel<Vec<u8>>,
    pty: PtyParam,
) -> Res<()> {
    info!("初始化:{:?}", TIME_HANDLER.to_string());
    {
        // 如果sid已经存在 直接修改reader
        let mut map = SESSION_STORE.write().await;
        let old = map.get_mut(&sid);
        if let Some(old) = old {
            old.reader = reader;
            debug!("{}存在 直接修改reader", sid);
            return Res::ok();
        }
    }
    // 创建session
    let _ = reader.send("连接主机···\r\n".into());
    let (tx, mut rx) = tokio::sync::mpsc::channel::<(u32, Value)>(32);
    // 创建channel
    let mut channel: Channel<Msg> = match server_get_channel(&server_id).await {
        Ok(c) => {
            let _ = reader.send("主机连接成功\r\n".into());
            c
        }
        Err(_) => {
            let _ = reader.send("连接失败\r\n".into());
            return Res::fail_code(1, "网络错误");
        }
    };
    let session_store = SessionStore {
        time: now(),
        sender: tx,
        reader,
    };
    {
        let mut map = SESSION_STORE.write().await;
        map.insert(sid.clone(), session_store);
    }
    {
        let sid = sid.clone();
        tokio::spawn(async move {
            let send_web = async |data: Vec<u8>| {
                let map = SESSION_STORE.read().await;
                let session = map.get(&sid);
                if let Some(session) = session {
                    let _ = session.reader.send(data.to_vec());
                }
            };
            let _ = channel
                .request_pty(
                    true,
                    pty.term(),
                    *pty.col_width(),
                    *pty.row_height(),
                    *pty.pix_width(),
                    *pty.pix_height(),
                    &[],
                )
                .await;
            let _ = channel.request_shell(true).await;
            loop {
                tokio::select! {
                    cmd = rx.recv() => {
                        if let Some((tp, val)) = cmd {
                            match tp {
                                // 发送shell
                                0 => {
                                    let str = val.as_str().unwrap();
                                    match channel.data(str.as_bytes()).await {
                                        Ok(_) => {
                                            debug!("发送命令:{}", val)
                                        }
                                        Err(e) => {
                                           debug!("发送失败 {:?}", e)
                                        }
                                    }
                                }
                                // 改变窗口
                                1 => {
                                    let pty:PtyParam = from_value(val).unwrap();
                                    match channel.window_change(
                                        *pty.col_width(),
                                        *pty.row_height(),
                                        *pty.pix_width(),
                                        *pty.pix_height()
                                    ).await {
                                        Ok(_) => {
                                            debug!("改变窗口成功")
                                        }
                                        Err(e) => {
                                            debug!("改变窗口失败 {:?}", e)
                                        }
                                    }
                                }
                                // 退出
                                2 => {
                                    debug!("shell结束");
                                    let _ = channel.close().await;
                                    break;
                                }
                                // ping
                                3 => {
                                    let mut map = SESSION_STORE.write().await;
                                    let session = map.get_mut(&sid);
                                    if let Some(session) = session {
                                        session.time = now();
                                    }
                                }
                                _ => {}
                            }
                        }
                    },
                    msg = channel.wait() => {
                        if let Some(msg) = msg {
                            match msg {
                                ChannelMsg::Data { ref data } => {
                                    debug!("接收到数据:{}", String::from_utf8_lossy(data));
                                    send_web(data.to_vec()).await;
                                }
                                ChannelMsg::Close => {
                                    debug!("shell结束0");
                                    break;
                                }
                                _ => {}
                            }
                        } else {
                            debug!("shell结束1");
                            break;
                        }
                    }
                }
            }
            info!("连接关闭");
            send_web(vec![0]).await;
            // 立即移除
            {
                let mut map = SESSION_STORE.write().await;
                map.remove(&sid);
            }
        });
    }
    Res::ok()
}
