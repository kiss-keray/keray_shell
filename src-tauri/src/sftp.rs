use crate::dto::res::Res;
use crate::sftp::TransferFileRes::{Cancelled, Paused, Success};
use crate::ssh::{server_get_channel, server_get_channel_other, ServerModel};
use crate::utils::now_millis;
use log::debug;
use once_cell::sync::Lazy;
use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::io::SeekFrom;
use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::RwLock;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

static DOWNLOAD_CTRL_STORE: Lazy<RwLock<HashMap<String, Arc<DownloadControl>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

#[derive(Default)]
struct DownloadControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    loaded: u64, // 已下载大小
    delta: u64,  // 增量
    total: u64,  // 总大小
}

// 获取下载控制器
async fn with_transfer_ctrl(request_id: &str) -> Arc<DownloadControl> {
    let mut map = DOWNLOAD_CTRL_STORE.write().await;
    map.entry(request_id.to_string())
        .or_insert_with(|| Arc::new(DownloadControl::default()))
        .clone()
}

// 暂停下载
#[tauri::command]
pub async fn transfer_pause(request_id: String) -> Res<()> {
    let map = DOWNLOAD_CTRL_STORE.read().await;
    let Some(ctrl) = map.get(&request_id) else {
        return Res::fail("下载任务不存在");
    };
    ctrl.paused.store(true, Ordering::SeqCst);
    Res::ok()
}

// 取消下载
#[tauri::command]
pub async fn transfer_cancel(request_id: String) -> Res<()> {
    let map = DOWNLOAD_CTRL_STORE.read().await;
    let Some(ctrl) = map.get(&request_id) else {
        return Res::fail("下载任务不存在");
    };
    ctrl.cancelled.store(true, Ordering::SeqCst);
    Res::ok()
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum TransferFileRes {
    Success,
    Paused,
    Cancelled,
}

fn __emit(
    stream: &tauri::ipc::Channel<DownloadProgressPayload>,
    loaded: &u64,
    delta: &u64,
    total: &u64,
) {
    let payload = DownloadProgressPayload {
        loaded: loaded.clone(),
        delta: delta.clone(),
        total: total.clone(),
    };
    let _ = stream.send(payload);
}
async fn __download_file(
    request_id: &String,
    server_id: &String,
    local_path: &String,
) -> Result<(File, Channel<Msg>, Arc<DownloadControl>), String> {
    // 前端已经创建了目录
    // 创建文件并打开文件
    let file_res = OpenOptions::new()
        .create(true)
        .append(true)
        .open(local_path)
        .await;

    let local_file = match file_res {
        Ok(file) => file,
        Err(_) => {
            return Err("打开本地文件失败".into());
        }
    };
    let channel = match server_get_channel(&server_id).await {
        Ok(channel) => channel,
        Err(_) => {
            return Err("服务器连接失败".into());
        }
    };
    let ctrl = with_transfer_ctrl(&request_id).await;
    ctrl.paused.store(false, Ordering::SeqCst);
    ctrl.cancelled.store(false, Ordering::SeqCst);
    Ok((local_file, channel, ctrl))
}

// 下载文件  cat方式 （适用任意大小的文件）
// 支持暂停 取消 继续
#[tauri::command]
pub async fn cat_download_file(
    stream: tauri::ipc::Channel<DownloadProgressPayload>,
    request_id: String,
    server_id: String,
    remote_path: String,
    local_path: String,
    offset: u64,
    total: u64,
) -> Res<TransferFileRes> {
    // 通知前端进度
    let emit = |loaded: u64, delta: u64| {
        __emit(&stream, &loaded, &delta, &total);
    };
    let (mut local_file, mut channel, ctrl) =
        match __download_file(&request_id, &server_id, &local_path).await {
            Ok(e) => e,
            Err(err) => {
                return Res::fail(&err);
            }
        };
    let remote_path_escaped = remote_path.replace('\'', r#"'\"'\"'"#);
    let cmd = if offset == 0 {
        format!("cat -- '{}'", remote_path_escaped)
    } else {
        format!("tail -c +{} -- '{}'", offset + 1, remote_path_escaped)
    };

    let mut loaded = offset; // 已经下载的大小
    let mut stderr_bytes: Vec<u8> = vec![]; //
    let mut exit_status: Option<u32> = None; // 退出状态
    let mut pending_delta: u64 = 0; // 每次通知的增量
    let mut last_emit_at = Instant::now(); // 上次通知的时间戳

    match channel.exec(true, cmd.as_bytes()).await {
        Ok(_) => {}
        Err(_) => {
            return Res::fail("下载失败");
        }
    }
    loop {
        if ctrl.cancelled.load(Ordering::SeqCst) {
            let _ = channel.close().await;
            let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
            ctrl_map.remove(&request_id);
            return Res::of(Cancelled);
        }
        if ctrl.paused.load(Ordering::SeqCst) {
            let _ = channel.close().await;
            let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
            ctrl_map.remove(&request_id);
            return Res::of(Paused);
        }
        let Some(msg) = channel.wait().await else {
            break;
        };
        match msg {
            ChannelMsg::Data { ref data } => {
                if data.is_empty() {
                    continue;
                }
                if let Err(_) = local_file.write_all(data).await {
                    let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
                    ctrl_map.remove(&request_id);
                    return Res::fail("写入本地文件失败");
                }
                let delta = data.len() as u64;
                loaded += delta;
                pending_delta += delta;
                // 进度事件节流，避免前端在高吞吐时被消息风暴阻塞。
                if pending_delta >= 1024 * 1024 || last_emit_at.elapsed().as_millis() >= 120 {
                    emit(loaded, pending_delta);
                    pending_delta = 0;
                    last_emit_at = Instant::now();
                }
            }
            ChannelMsg::ExtendedData { ref data, ext } => {
                if ext == 1 {
                    stderr_bytes.extend(data.iter().copied());
                }
            }
            ChannelMsg::ExitStatus { exit_status: s } => {
                exit_status = Some(s);
            }
            _ => {}
        }
    }
    if let Some(code) = exit_status {
        if code != 0 {
            let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
            ctrl_map.remove(&request_id);
            return Res::fail("下载失败");
        }
    }
    if pending_delta > 0 {
        emit(loaded, pending_delta);
    }
    let _ = local_file.flush().await;
    let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
    ctrl_map.remove(&request_id);
    Res::of(Success)
}

// 下载文件 使用sftp实现  速度比cat_download_file慢
#[tauri::command]
pub async fn download_file(
    stream: tauri::ipc::Channel<DownloadProgressPayload>,
    request_id: String,
    server_id: String,
    remote_path: String,
    local_path: String,
    offset: u64,
    total: u64,
) -> Res<TransferFileRes> {
    let emit = |loaded: u64, delta: u64| {
        __emit(&stream, &loaded, &delta, &total);
    };
    let (local_file, channel, ctrl) =
        match __download_file(&request_id, &server_id, &local_path).await {
            Ok(e) => e,
            Err(err) => {
                return Res::fail(&err);
            }
        };
    emit(offset, 0);
    let local_file = Arc::new(Mutex::new(local_file));
    let loaded = Arc::new(AtomicU64::new(offset)); // 已经下载的大小
    let pending_delta = Arc::new(AtomicU64::new(0)); // 每次通知的增量
    let last_emit_at = Arc::new(AtomicU64::new(now_millis())); // 上次通知的时间戳
    let res = Arc::new(AtomicI8::new(1)); // 结束状态 0 暂停 -1 取消 1成功
    match _sftp_read(channel, &remote_path, &offset, |bys| {
        let request_id = request_id.clone();
        let ctrl = ctrl.clone();
        let local_file = local_file.clone();
        let loaded = loaded.clone();
        let pending_delta = pending_delta.clone();
        let last_emit_at = last_emit_at.clone();
        let res = res.clone();
        async move {
            let cancelled = ctrl.cancelled.load(Ordering::SeqCst);
            let paused = ctrl.paused.load(Ordering::SeqCst);
            if cancelled || paused {
                let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
                ctrl_map.remove(&request_id);
                if cancelled {
                    res.store(-1, Ordering::SeqCst);
                } else {
                    res.store(0, Ordering::SeqCst);
                }
                return Ok(0);
            }
            let mut local_file = local_file.lock().await;
            if let Err(_) = local_file.write_all(&bys).await {
                let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
                ctrl_map.remove(&request_id);
                return Err("写入本地文件失败".into());
            }
            let delta = bys.len() as u64;
            let _loaded = loaded.fetch_add(delta, Ordering::SeqCst);
            let size = pending_delta.fetch_add(delta, Ordering::SeqCst);
            let now = now_millis();
            // 进度事件节流，避免前端在高吞吐时被消息风暴阻塞。
            if size >= 1024 * 1024
                || now - last_emit_at.load(Ordering::SeqCst) >= 120
                || delta >= total
            // delta >= total表示下载完成 强制刷新进度
            {
                emit(_loaded, size);
                pending_delta.store(0, Ordering::SeqCst);
                last_emit_at.store(now, Ordering::SeqCst);
            }
            Ok(1)
        }
    })
    .await
    {
        Ok(()) => {
            let n = res.load(Ordering::SeqCst);
            if n == -1 {
                return Res::of(Cancelled);
            }
            if n == 0 {
                return Res::of(Paused);
            }
            Res::of(Success)
        }
        Err(_) => Res::fail("下载失败"),
    }
}

async fn __upload_file(
    request_id: &String,
    server_id: &String,
    local_path: &String,
    offset: u64,
) -> Result<(File, Channel<Msg>, Arc<DownloadControl>), String> {
    // 前端已经创建了目录
    // 创建文件并打开文件
    let mut local_file = match File::open(local_path).await {
        Err(_) => {
            return Err("打开本地文件失败".into());
        }
        Ok(file) => file,
    };
    match local_file.seek(SeekFrom::Start(offset)).await {
        Ok(_) => (),
        Err(_) => {
            return Err("打开本地文件失败".into());
        }
    }
    let channel = match server_get_channel(&server_id).await {
        Ok(channel) => channel,
        Err(_) => {
            return Err("服务器连接失败".into());
        }
    };
    let ctrl = with_transfer_ctrl(&request_id).await;
    ctrl.paused.store(false, Ordering::SeqCst);
    ctrl.cancelled.store(false, Ordering::SeqCst);
    Ok((local_file, channel, ctrl))
}

// 上传文件
#[tauri::command]
pub async fn upload_file(
    stream: tauri::ipc::Channel<DownloadProgressPayload>,
    request_id: String,
    server_id: String,
    remote_path: String,
    local_path: String,
    offset: u64,
    total: u64,
) -> Res<TransferFileRes> {
    let emit = |loaded: u64, delta: u64| {
        __emit(&stream, &loaded, &delta, &total);
    };
    let (local_file, channel, ctrl) =
        match __upload_file(&request_id, &server_id, &local_path, offset).await {
            Ok(e) => e,
            Err(err) => {
                return Res::fail(&err);
            }
        };
    emit(offset, 0);
    let local_file = Arc::new(Mutex::new(local_file));
    let loaded = Arc::new(AtomicU64::new(offset)); // 已经上传的大小
    let pending_delta = Arc::new(AtomicU64::new(0)); // 每次通知的增量
    let last_emit_at = Arc::new(AtomicU64::new(now_millis())); // 上次通知的时间戳
    let res = Arc::new(AtomicI8::new(1)); // 结束状态 0 暂停 -1 取消 1成功
    match _sftp_write(channel, &remote_path, &true, || {
        let request_id = request_id.clone();
        let ctrl = ctrl.clone();
        let local_file = local_file.clone();
        let loaded = loaded.clone();
        let pending_delta = pending_delta.clone();
        let last_emit_at = last_emit_at.clone();
        let res = res.clone();
        async move {
            let cancelled = ctrl.cancelled.load(Ordering::SeqCst);
            let paused = ctrl.paused.load(Ordering::SeqCst);
            if cancelled || paused {
                let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
                ctrl_map.remove(&request_id);
                if cancelled {
                    res.store(-1, Ordering::SeqCst);
                } else {
                    res.store(0, Ordering::SeqCst);
                }
                return Ok(None);
            }
            let mut local_file = local_file.lock().await;
            let mut buf = vec![0u8; 10 * 1024 * 1024];
            match local_file.read(&mut buf).await {
                Ok(n) => {
                    let delta = n as u64;
                    let _loaded = loaded.fetch_add(delta, Ordering::SeqCst);
                    let size = pending_delta.fetch_add(delta, Ordering::SeqCst);
                    let now = now_millis();
                    // 进度事件节流，避免前端在高吞吐时被消息风暴阻塞。
                    if now - last_emit_at.load(Ordering::SeqCst) >= 100
                        || size >= 1024 * 1024
                        || n == 0
                    // n=0表述读取结束  结束后强制刷新进度
                    {
                        emit(_loaded, size);
                        pending_delta.store(0, Ordering::SeqCst);
                        last_emit_at.store(now, Ordering::SeqCst);
                    }
                    if n == 0 {
                        return Ok(None);
                    }
                    buf.truncate(n);
                    Ok(Some(buf))
                }
                Err(_) => {
                    let mut ctrl_map = DOWNLOAD_CTRL_STORE.write().await;
                    ctrl_map.remove(&request_id);
                    return Err("读取失败".into());
                }
            }
        }
    })
    .await
    {
        Ok(()) => {
            let n = res.load(Ordering::SeqCst);
            if n == 0 {
                return Res::of(Paused);
            }
            if n == -1 {
                return Res::of(Cancelled);
            }
            Res::of(Success)
        }
        Err(_) => Res::fail("上传失败"),
    }
}

// 使用server流式读取文件
// 不支持暂停 继续
#[tauri::command]
pub async fn sftp_read(
    server_id: String,
    path: String,
    offset: u64,
    stream: tauri::ipc::Channel<Vec<u8>>,
) -> Res<()> {
    let channel = match server_get_channel(&server_id).await {
        Ok(c) => c,
        Err(e) => return Res::fail(e),
    };
    match _sftp_read(channel, &path, &offset, |bys| {
        let stream = stream.clone();
        async move {
            match stream.send(bys) {
                Ok(_) => Ok(1),
                Err(_) => Err("".into()),
            }
        }
    })
    .await
    {
        Ok(_) => Res::ok(),
        Err(_) => Res::fail("读取失败"),
    }
}

// 上传本地文件
// 不支持暂停 继续
#[tauri::command]
pub async fn sftp_upload_local_file(
    server_id: String,
    remote_path: String,
    local_path: String,
    append: Option<bool>,
    stream: tauri::ipc::Channel<f32>, // 通知进度
) -> Res<()> {
    let channel = match server_get_channel(&server_id).await {
        Ok(c) => c,
        Err(e) => return Res::fail(e),
    };
    let file = match File::open(local_path).await {
        Ok(f) => Arc::new(Mutex::new(f)),
        Err(_) => return Res::fail("本地路径错误"),
    };
    let total;
    {
        let file = file.lock().await;
        total = file.metadata().await.unwrap().len();
    }
    let loaded = Arc::new(AtomicU64::new(0));
    let result = _sftp_write(channel, &remote_path, &append.unwrap_or(false), || {
        let file = file.clone();
        let total = total.clone();
        let stream = stream.clone();
        let loaded = loaded.clone();
        async move {
            let mut buf = vec![0u8; 64 * 1024];
            let mut file = file.lock().await;
            match file.read(&mut buf).await {
                Ok(n) => {
                    if n > 0 {
                        buf.truncate(n); // 别忘了截断
                        let loaded = loaded.fetch_add(n as u64, Ordering::SeqCst);
                        let _ = stream.send(loaded as f32 / total as f32);
                        Ok(Some(buf))
                    } else {
                        // 上传完成
                        let _ = stream.send(100f32);
                        Ok(None)
                    }
                }
                _ => Err("读取失败".into()),
            }
        }
    })
    .await;
    match result {
        Ok(_) => Res::ok(),
        Err(_) => Res::fail("写入失败"),
    }
}

// 直接使用账号密码完整读取
#[tauri::command]
pub async fn one_read_string(
    ip: String,
    port: u16,
    user: String,
    password: String,
    path: String,
) -> Res<String> {
    let mut server = ServerModel::default();
    server.set_ip(ip);
    server.set_port(port);
    server.set_user(user);
    server.set_password(Some(password));
    let channel = match server_get_channel_other(&server).await {
        Ok(c) => c,
        Err(e) => return Res::fail(e),
    };
    let res = Arc::new(Mutex::new(vec![]));
    match _sftp_read(channel, &path, &0, |bys| {
        let res = res.clone();
        async move {
            let mut lock = res.lock().await;
            lock.extend(bys);
            return Ok(1);
        }
    })
    .await
    {
        Ok(_) => {
            let lock = res.lock().await;
            let bytes = lock.clone();
            drop(lock);
            Res::of(String::from_utf8_lossy(&bytes).to_string())
        }
        Err(e) => Res::fail(e.to_string()),
    }
}

// 直接使用账号密码完整写入
#[tauri::command]
pub async fn one_write_string(
    ip: String,
    port: u16,
    user: String,
    password: String,
    path: String,
    content: String,
) -> Res<()> {
    let mut server = ServerModel::default();
    server.set_ip(ip);
    server.set_port(port);
    server.set_user(user);
    server.set_password(Some(password));
    let channel = match server_get_channel_other(&server).await {
        Ok(c) => c,
        Err(e) => return Res::fail(e),
    };
    let ok = Arc::new(AtomicBool::new(false));
    match _sftp_write(channel, &path, &false, || {
        let ok = ok.clone();
        let content = content.clone();
        async move {
            if ok.load(Ordering::Relaxed) {
                return Ok(None);
            }
            ok.store(true, Ordering::Relaxed);
            Ok(Some(content.into_bytes()))
        }
    })
    .await
    {
        Ok(_) => {
            return Res::ok();
        }
        Err(_) => {}
    }
    Res::fail("上传失败")
}

// 流式读取文件
async fn _sftp_read<F, Fut>(
    channel: Channel<Msg>,
    path: &String,
    offset: &u64,
    call: F,
) -> Result<(), String>
where
    F: Fn(Vec<u8>) -> Fut,
    Fut: Future<Output = Result<u8 /* 0停止 1继续*/, String>>,
{
    channel.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
        debug!("SftpSession创建失败 {:?}", e);
        "通道创建失败".to_string()
    })?;
    let mut file = sftp.open_with_flags(path, OpenFlags::READ).await.unwrap();
    file.seek(SeekFrom::Start(*offset)).await.unwrap();
    // 读写异步
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(10);
    let write_flag = Arc::new(AtomicBool::new(true));
    let write_flag1 = write_flag.clone();
    let future: JoinHandle<Result<(), String>> = tokio::spawn(async move {
        loop {
            if !write_flag1.load(Ordering::Relaxed) {
                // 外部写入失败 直接返回OK
                break;
            }
            let mut buf = vec![0u8; 10 * 1024 * 1024];
            match file.read(&mut buf).await {
                Ok(n) => {
                    if n > 0 {
                        buf.truncate(n);
                        let _ = tx.send(buf).await;
                    } else {
                        break;
                    }
                }
                Err(_) => return Err("读取失败".into()),
            }
        }
        drop(tx);
        Ok(())
    });
    loop {
        let data = rx.recv().await;
        if let Some(bys) = data {
            match call(bys).await {
                Ok(_) => continue,
                // 回调写入失败了  直接返回错误
                Err(e) => {
                    // 通知异步线程写入失败  不要再读了
                    write_flag.store(false, Ordering::Relaxed);
                    return Err(e);
                }
            }
        }
        // 读取完成或者失败了  直接使用future的返回
        else {
            break;
        }
    }
    future.await.unwrap_or_else(|_| Err("读取失败".into()))
}

// 流式写入文件
async fn _sftp_write<F, Fut>(
    channel: Channel<Msg>,
    path: &String,
    append: &bool,
    call: F,
) -> Result<(), String>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Option<Vec<u8>>, String>>,
{
    channel.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
        debug!("SftpSession创建失败 {:?}", e);
        "通道创建失败".to_string()
    })?;
    if path == "/" {
        return Err("路径错误".into());
    }
    match ensure_parent_dirs(&sftp, &path).await {
        Ok(_) => {}
        Err(_) => return Err("路径错误".into()),
    };
    if !*append {
        // 忽略删除不存在的错误
        let _ = sftp.remove_file(path.clone()).await.map_err(|_| {});
    }

    let mut file = match sftp
        .open_with_flags(
            path,
            OpenFlags::WRITE | OpenFlags::APPEND | OpenFlags::CREATE,
        )
        .await
    {
        Ok(f) => f,
        Err(_) => return Err("路径错误".into()),
    };
    // 读写分成两个异步
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(10);
    let write_flag = Arc::new(AtomicBool::new(true));
    let write_flag1 = write_flag.clone();
    let future: JoinHandle<Result<(), String>> = tokio::spawn(async move {
        loop {
            let data = rx.recv().await;
            if let Some(bys) = data {
                match file.write_all(&bys).await {
                    Ok(_) => {}
                    Err(_) => {
                        write_flag1.store(false, Ordering::Relaxed);
                        let _ = file.shutdown().await;
                        return Err("写入失败".into());
                    }
                }
                match file.flush().await {
                    Ok(_) => {}
                    Err(_) => {
                        write_flag1.store(false, Ordering::Relaxed);
                        let _ = file.shutdown().await;
                        return Err("刷新失败".into());
                    }
                }
            } else {
                // 读取失败或者结束了  读取失败的错误外层处理了
                break;
            }
        }
        let _ = file.shutdown().await;
        Ok(())
    });
    loop {
        if !write_flag.load(Ordering::Relaxed) {
            // 写入失败了 返回future的Error
            break;
        }
        match call().await {
            Ok(bys) => {
                if bys.is_none() {
                    break;
                }
                let _ = tx.send(bys.unwrap()).await;
            }
            Err(e) => {
                return Err(e);
            }
        }
    }
    // drop掉tx  保证future能够拿到None
    drop(tx);
    future.await.unwrap_or_else(|_| Err("写入失败".into()))
}

// 确保父目录存在
async fn ensure_parent_dirs(sftp: &SftpSession, file_path: &str) -> Result<(), String> {
    let ps = posix_parent_dirs(file_path).unwrap_or(vec![]);
    if ps.is_empty() {
        return Err("路径错误".into());
    }
    for p in ps {
        if sftp.try_exists(&p).await.unwrap_or(false) {
            continue;
        }
        if let Err(e) = sftp.create_dir(&p).await {
            if !sftp.try_exists(&p).await.unwrap_or(false) {
                return Err(format!("创建目录失败: {p}, {e}"));
            }
        }
    }
    Ok(())
}

// 远程路径一律当 POSIX 字符串处理
fn posix_parent_dirs(file_path: &str) -> Option<Vec<String>> {
    let path = file_path.trim_end_matches('/');
    let parent = path.rsplit_once('/')?.0; // "/a/b/c/file" -> "/a/b/c"
    if parent.is_empty() || parent == "/" {
        return Some(vec![]);
    }
    let mut dirs = vec![];
    let mut acc = String::new();
    for part in parent.split('/').filter(|s| !s.is_empty()) {
        acc = if acc.is_empty() {
            format!("/{part}") // 第一段 -> "/a"
        } else {
            format!("{acc}/{part}") // -> "/a/b"
        };
        dirs.push(acc.clone());
    }
    Some(dirs) // ["/a", "/a/b", "/a/b/c"]
}
