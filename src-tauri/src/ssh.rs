use crate::channel::server_get_channel_pool;
use crate::dto::res::Res;
use getset::{Getters, Setters};
use log::debug;
use once_cell::sync::Lazy;
use russh::client::Msg;
use russh::{Channel, ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{watch, RwLock};

#[derive(Debug, Serialize, Deserialize, Getters, Setters, Default, Clone)]
#[serde(rename_all = "camelCase")]
#[getset(get = "pub", set = "pub")]
pub struct ServerModel {
    pub id: String,
    pub ip: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    #[serde(rename = "passphrase")]
    pub private_key_passphrase: Option<String>,
}

/// 非交互 SSH 命令的完整执行结果，供前端按退出码判断成功与否。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCommandResult {
    stdout: String,
    stderr: String,
    /// SSH 服务端可能不发送 ExitStatus，此时返回 null，由前端降级为文本判断。
    exit_code: Option<u32>,
}

/// 服务器数据存储
pub static SERVER_STORE: Lazy<RwLock<HashMap<String, ServerModel>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Agent 静默命令的取消通道。键由前端为每次执行生成，只中断对应的 SSH channel。
static EXEC_CANCEL_STORE: Lazy<RwLock<HashMap<String, watch::Sender<bool>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

const EXEC_CANCELLED_MESSAGE: &str = "命令已取消";

// 根据id获取服务器数据
pub async fn get_server_by_id(server_id: &str) -> Option<ServerModel> {
    let lock = SERVER_STORE.read().await;
    lock.get(server_id).cloned()
}

async fn wait_exec_cancel(cancel_rx: &mut watch::Receiver<bool>) {
    if !*cancel_rx.borrow() {
        let _ = cancel_rx.changed().await;
    }
}

/// 先发送 SIGINT，再关闭当前 channel。关闭的是本次 exec channel，不影响复用的 SSH handle。
async fn interrupt_exec_channel(channel: &Channel<Msg>) {
    let _ = channel.signal(Sig::INT).await;
    let _ = channel.close().await;
}

async fn exec_shell_with_cancel(
    server_id: &str,
    cmd: &str,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<ExecCommandResult, String> {
    let channel = tokio::select! {
        result = server_get_channel_pool(server_id) => result?,
        _ = wait_exec_cancel(cancel_rx) => return Err(EXEC_CANCELLED_MESSAGE.to_string()),
    };
    let (mut channel, _permit) = channel;
    let exec_result = tokio::select! {
        result = channel.exec(true, cmd.as_bytes()) => result,
        _ = wait_exec_cancel(cancel_rx) => {
            interrupt_exec_channel(&channel).await;
            return Err(EXEC_CANCELLED_MESSAGE.to_string());
        }
    };
    exec_result.map_err(|e| {
        debug!("发送失败 {:?}", e);
        "命令发送失败".to_string()
    })?;
    debug!("发送命令:{}", cmd);
    let mut stdout_bytes: Vec<u8> = vec![];
    let mut stderr_bytes: Vec<u8> = vec![];
    let mut exit_status: Option<u32> = None;
    loop {
        let msg = tokio::select! {
            msg = channel.wait() => msg,
            _ = wait_exec_cancel(cancel_rx) => {
                interrupt_exec_channel(&channel).await;
                return Err(EXEC_CANCELLED_MESSAGE.to_string());
            }
        };
        let Some(msg) = msg else {
            break;
        };
        match msg {
            ChannelMsg::Data { ref data } => {
                stdout_bytes.extend(data.to_vec());
            }
            ChannelMsg::ExtendedData { ref data, ext } => {
                // 1 输出的stderr流
                if ext == 1 {
                    stderr_bytes.extend(data.to_vec());
                } else {
                    stdout_bytes.extend(data.to_vec());
                }
            }
            ChannelMsg::ExitStatus { exit_status: s } => {
                exit_status = Some(s);
            }
            _ => {}
        }
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
    if !stderr.is_empty() {
        debug!("远端 stderr: {}", stderr);
    }
    if let Some(code) = exit_status {
        if code != 0 {
            debug!("远端命令退出码:{}", code);
            // 非零退出码属于命令执行结果，不转换成 Tauri 调用错误，由前端更新命令状态。
        }
    }
    Ok(ExecCommandResult {
        stdout,
        stderr,
        exit_code: exit_status,
    })
}

#[tauri::command]
pub async fn exec_cmd(
    server_id: String,
    cmd: String,
    execution_id: Option<String>,
) -> Res<ExecCommandResult> {
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    if let Some(id) = execution_id.as_ref() {
        EXEC_CANCEL_STORE
            .write()
            .await
            .insert(id.clone(), cancel_tx.clone());
    }
    let result = exec_shell_with_cancel(&server_id, &cmd, &mut cancel_rx).await;
    if let Some(id) = execution_id.as_ref() {
        EXEC_CANCEL_STORE.write().await.remove(id);
    }
    drop(cancel_tx);
    match result {
        Ok(exec_result) => Res::of(exec_result),
        Err(msg) => Res::fail(msg),
    }
}

#[tauri::command]
pub async fn cancel_exec_cmd(execution_id: String) -> Res<()> {
    let sender = EXEC_CANCEL_STORE.read().await.get(&execution_id).cloned();
    if let Some(sender) = sender {
        let _ = sender.send(true);
    }
    Res::ok()
}

// 同步服务器数据
#[tauri::command]
pub async fn sync_server_data(servers: Vec<ServerModel>) -> Res<()> {
    let mut map = SERVER_STORE.write().await;
    map.clear();
    for server in servers {
        map.insert(server.id.clone(), server);
    }
    Res::ok()
}
