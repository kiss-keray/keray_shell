use crate::channel::{server_model_get_channel, Client};
use crate::ssh::get_server_by_id;
use crate::utils::now_millis;
use log::warn;
use once_cell::sync::Lazy;
use russh::client::{Handle, Msg};
use russh::{Channel, ChannelMsg, Disconnect};
use std::cmp::{max, Reverse};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OnceCell, OwnedSemaphorePermit, RwLock, Semaphore};

/// 无法读取远端 MaxSessions 时沿用原容量，避免探测失败阻断池初始化。
const DEFAULT_CHANNELS_PER_HANDLE: usize = 5;
/// CPU 计算出的最小池最多预热 2 个 Handle，避免首次建立过多 SSH 连接。
const MAX_MIN_HANDLES: usize = 2;
/// 单台服务器池最多持有 20 个 Handle，防止异常并发无限创建 SSH 连接。
const MAX_POOL_HANDLES: usize = 20;
/// 远端 CPU 探测只用于计算池参数，不应长时间阻塞第一次业务请求。
const CPU_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// 达到最大容量后轮询不同 Handle，避免一直等待某个长任务占用的 Handle。
const HANDLE_WAIT_INTERVAL: Duration = Duration::from_millis(250);
/// 使用量或获取时间的检查间隔；5 分钟阈值最多只会多延迟一个检查周期。
const POOL_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(5);
/// 使用量持续低于最小容量达到该时间后，把池收缩回服务器自己的最小 Handle 数。
const LOW_USAGE_SHRINK_AFTER: Duration = Duration::from_secs(5 * 60);
/// 连续没有获取新 Channel 达到该时间后，空池会从全局存储中移除并关闭。
const POOL_INACTIVE_CLOSE_AFTER: Duration = Duration::from_secs(5 * 60);

/// 所有服务器的 Channel 池；池对象本身按 server_id 懒加载。
static CHANNEL_POOL_STORE: Lazy<RwLock<HashMap<String, Arc<ServerChannelPool>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

struct HandleStore {
    handle: Handle<Client>,
    semaphore: Arc<Semaphore>,
    capacity: usize,
    /// 缩容中的 Handle 不再接收新 Channel，已有 Channel 释放完后再安全断开。
    draining: AtomicBool,
}

/// 每台服务器独立保存池参数，后续可以按服务器 CPU 得到不同的容量与扩容速度。
struct ChannelPoolConfig {
    /// 当前服务器配置允许单个 SSH Handle 承载的最大 Channel 数。
    channels_per_handle: usize,
    min_handles: usize,
    max_handles: usize,
    expansion_ratio: f64,
    /// 最近一次成功把 Channel 交给调用方的毫秒时间戳。
    last_acquired_at: AtomicU64,
}

impl ChannelPoolConfig {
    fn from_server_limits(cpu_count: usize, channels_per_handle: usize) -> Self {
        let cpu_count = cpu_count.max(1);
        // 同时限制信号量和总容量乘法，避免异常 MaxSessions 令 Semaphore 构造 panic。
        let channels_per_handle =
            channels_per_handle.clamp(1, Semaphore::MAX_PERMITS / MAX_POOL_HANDLES);
        let min_handles = cpu_count
            .div_ceil(channels_per_handle)
            .clamp(1, MAX_MIN_HANDLES);
        let max_handles = cpu_count.clamp(min_handles + 1, MAX_POOL_HANDLES);

        // 小规格服务器连接数少，扩容时需要更快补足；高规格服务器降低单次扩容幅度，
        // 避免一次认证过多 SSH Handle 给远端带来瞬时压力。
        let expansion_ratio = match cpu_count {
            1..=2 => 2.0,
            3..=8 => 1.5,
            _ => 1.25,
        };

        Self {
            channels_per_handle,
            min_handles,
            max_handles,
            expansion_ratio,
            last_acquired_at: AtomicU64::new(now_millis()),
        }
    }

    /// 按扩容比例计算下一批 Handle 数，预热降级时先补齐服务器最小值。
    fn expanded_handle_count(&self, current_handles: usize) -> usize {
        if current_handles < self.min_handles {
            return self.min_handles;
        }
        let expanded = ((current_handles as f64) * self.expansion_ratio).ceil() as usize;
        expanded.max(self.min_handles).min(self.max_handles)
    }

    /// 维护任务统计的是在用 Channel 数，需要把最小 Handle 数换算成同一单位。
    fn min_channel_capacity(&self) -> usize {
        self.min_handles.saturating_mul(self.channels_per_handle)
    }
}

/// 完成懒加载后的池状态；初始化失败时 OnceCell 不会缓存错误，后续请求可以重试。
struct InitializedChannelPool {
    config: ChannelPoolConfig,
    handles: RwLock<Vec<Arc<HandleStore>>>,
    resize_lock: Mutex<()>,
    next_handle: AtomicUsize,
    current_channels: Arc<AtomicUsize>,
}

pub struct ServerChannelPool {
    server_id: String,
    initialized: OnceCell<InitializedChannelPool>,
    /// 当前已经交给业务方、尚未释放许可的 Channel 数量。
    current_channels: Arc<AtomicUsize>,
    maintenance_started: AtomicBool,
    closed: AtomicBool,
    /// 获取操作持有读锁，关闭操作持有写锁，避免空闲关闭与新获取同时发生。
    lifecycle_lock: RwLock<()>,
}

/// 与池化 Channel 同生命周期的许可；释放时同步扣减服务器当前使用数。
pub struct ChannelPoolPermit {
    permit: Option<OwnedSemaphorePermit>,
    current_channels: Arc<AtomicUsize>,
}

impl Drop for ChannelPoolPermit {
    fn drop(&mut self) {
        // 先归还 Handle 名额，再扣减全池使用数，维护任务看到 0 时信号量状态也已经一致。
        drop(self.permit.take());
        self.current_channels.fetch_sub(1, Ordering::AcqRel);
    }
}

impl ServerChannelPool {
    fn new(server_id: &str) -> Self {
        let current_channels = Arc::new(AtomicUsize::new(0));
        Self {
            server_id: server_id.to_string(),
            initialized: OnceCell::new(),
            current_channels,
            maintenance_started: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            lifecycle_lock: RwLock::new(()),
        }
    }

    /// 第一次使用服务器时探测远端 CPU 与 MaxSessions，并预热最小数量的 Handle。
    async fn initialize(&self) -> Result<&InitializedChannelPool, String> {
        self.initialized
            .get_or_try_init(|| async {
                let (first_handle, mut config_channel) =
                    create_server_handle(&self.server_id).await?;
                let (cpu_count, channels_per_handle) =
                    detect_server_limits(&mut config_channel).await;
                // 预留一个
                let channels_per_handle = max(channels_per_handle - 1, 1);
                let _ = config_channel.close().await;
                let config = ChannelPoolConfig::from_server_limits(cpu_count, channels_per_handle);
                let first_handle = new_handle_store(first_handle, config.channels_per_handle);

                let mut handles = Vec::with_capacity(config.min_handles);
                handles.push(first_handle);

                // 所有 Handle 先放在局部变量中，初始化任务被取消时不会留下半初始化池。
                while handles.len() < config.min_handles {
                    match create_handle_store(&self.server_id, config.channels_per_handle).await {
                        Ok((handle_store, channel)) => {
                            let _ = channel.close().await;
                            handles.push(handle_store);
                        }
                        Err(error) => {
                            // 已有一个可用 Handle 时允许降级启动，下一次池耗尽会继续补足容量。
                            warn!(
                                "服务器 {} 的 Channel 池预热未达到最小容量: {}",
                                self.server_id, error
                            );
                            break;
                        }
                    }
                }

                Ok(InitializedChannelPool {
                    config,
                    handles: RwLock::new(handles),
                    resize_lock: Mutex::new(()),
                    next_handle: AtomicUsize::new(0),
                    current_channels: Arc::clone(&self.current_channels),
                })
            })
            .await
    }

    /// 获取期间阻止维护任务关闭池；初始化成功后只启动一个维护任务。
    pub async fn acquire_channel(
        self: &Arc<Self>,
    ) -> Result<(Channel<Msg>, ChannelPoolPermit), String> {
        let _lifecycle_guard = self.lifecycle_lock.read().await;
        if self.closed.load(Ordering::Acquire) {
            return Err("Channel池已关闭".into());
        }

        let initialized = self.initialize().await?;
        self.start_maintenance();
        acquire_pooled_channel(&self.server_id, initialized).await
    }

    fn start_maintenance(self: &Arc<Self>) {
        if self
            .maintenance_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let weak_pool = Arc::downgrade(self);
        tokio::spawn(async move {
            maintain_server_pool(weak_pool).await;
        });
    }
}

/// 池只按 server_id 创建一次，后续创建 Handle 时再读取最新 ServerModel。
pub async fn get_or_create_server_pool(server_id: &str) -> Arc<ServerChannelPool> {
    {
        let pools = CHANNEL_POOL_STORE.read().await;
        if let Some(pool) = pools.get(server_id) {
            return Arc::clone(pool);
        }
    }

    let mut pools = CHANNEL_POOL_STORE.write().await;
    if let Some(pool) = pools.get(server_id) {
        return Arc::clone(pool);
    }
    let pool = Arc::new(ServerChannelPool::new(server_id));
    pools.insert(server_id.to_string(), Arc::clone(&pool));
    pool
}

/// 首次连接时同时读取 CPU 和 sshd MaxSessions；读取失败时分别使用本机 CPU 和默认容量。
async fn detect_server_limits(channel: &mut Channel<Msg>) -> (usize, usize) {
    // `sshd -T` 会合并 Include 等配置；普通用户无权执行时再读取主配置文件中的显式值。
    // 两种方式都失败并不影响连接，只会回退到原先每 Handle 5 个 Channel 的配置。
    const SERVER_LIMIT_QUERY: &[u8] = br#"
printf 'cpu='
(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)
printf '\nmax_sessions='
max_sessions="$(
    (sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null || /usr/local/sbin/sshd -T 2>/dev/null) |
    awk '$1 == "maxsessions" { print $2; exit }'
)"
if [ -z "$max_sessions" ]; then
    max_sessions="$(awk 'tolower($1) == "maxsessions" { print $2; exit }' /etc/ssh/sshd_config 2>/dev/null)"
fi
printf '%s\n' "$max_sessions"
"#;

    let detected = tokio::time::timeout(CPU_QUERY_TIMEOUT, async {
        channel.exec(true, SERVER_LIMIT_QUERY).await.ok()?;
        let mut stdout = Vec::new();
        while let Some(message) = channel.wait().await {
            if let ChannelMsg::Data { data } = message {
                stdout.extend_from_slice(&data);
            }
        }
        let stdout = String::from_utf8_lossy(&stdout);
        let read_value = |key: &str| {
            stdout.lines().find_map(|line| {
                line.trim()
                    .strip_prefix(key)
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .filter(|value| *value > 0)
            })
        };
        Some((read_value("cpu="), read_value("max_sessions=")))
    })
    .await
    .ok()
    .flatten()
    .unwrap_or((None, None));

    let cpu_count = detected.0.unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
    });
    let channels_per_handle = detected.1.unwrap_or(DEFAULT_CHANNELS_PER_HANDLE);
    (cpu_count, channels_per_handle)
}

/// 新建 Handle 时必须通过 server_model_get_channel，并在每次连接前读取最新 ServerModel。
async fn create_server_handle(server_id: &str) -> Result<(Handle<Client>, Channel<Msg>), String> {
    // 每次创建 Handle 都重新读取 ServerModel，确保使用服务器当前的连接参数。
    let server = get_server_by_id(server_id)
        .await
        .ok_or_else(|| "服务器不存在".to_string())?;
    server_model_get_channel(&server).await
}

fn new_handle_store(handle: Handle<Client>, capacity: usize) -> Arc<HandleStore> {
    Arc::new(HandleStore {
        handle,
        semaphore: Arc::new(Semaphore::new(capacity)),
        capacity,
        draining: AtomicBool::new(false),
    })
}

/// 按当前服务器池配置包装 Handle，并复用连接时已经打开的首个 Channel。
async fn create_handle_store(
    server_id: &str,
    capacity: usize,
) -> Result<(Arc<HandleStore>, Channel<Msg>), String> {
    let (handle, channel) = create_server_handle(server_id).await?;
    Ok((new_handle_store(handle, capacity), channel))
}

async fn current_pool_handle_count(pool: &InitializedChannelPool) -> usize {
    pool.handles
        .read()
        .await
        .iter()
        .filter(|handle| !handle.draining.load(Ordering::Acquire))
        .count()
}

async fn remove_handle(pool: &InitializedChannelPool, removed: &Arc<HandleStore>) {
    pool.handles
        .write()
        .await
        .retain(|handle| !Arc::ptr_eq(handle, removed));
}

/// 使用已占用的名额打开 Channel；打开失败说明 Handle 已不可用，需要从池中移除。
async fn open_handle_channel(
    pool: &InitializedChannelPool,
    handle_store: &Arc<HandleStore>,
    permit: OwnedSemaphorePermit,
) -> Option<(Channel<Msg>, OwnedSemaphorePermit)> {
    match handle_store.handle.channel_open_session().await {
        Ok(channel) => Some((channel, permit)),
        Err(_) => {
            drop(permit);
            remove_handle(pool, handle_store).await;
            None
        }
    }
}

/// 从已有 Handle 获取名额；传入超时后，无立即可用名额时轮换等待一个 Handle。
async fn try_open_existing_channel(
    pool: &InitializedChannelPool,
    wait_timeout: Option<Duration>,
) -> Option<(Channel<Msg>, OwnedSemaphorePermit)> {
    let handles = pool.handles.read().await.clone();
    if handles.is_empty() {
        return None;
    }
    let start = pool.next_handle.fetch_add(1, Ordering::Relaxed) % handles.len();
    let try_open = async |wait_timeout: Option<Duration>| {
        for offset in 0..handles.len() {
            // 通过start循环回绕遍历  start=2，len=3时  遍历为 2->0->1
            let handle_store = &handles[(start + offset) % handles.len()];
            if handle_store.draining.load(Ordering::Acquire) {
                continue;
            }
            if handle_store.handle.is_closed() {
                remove_handle(pool, handle_store).await;
                continue;
            }
            if let Some(wait_timeout) = wait_timeout {
                // 前面已无立即可用名额，只等待一个有效 Handle；超时后由外层循环换下一个。
                let permit = match tokio::time::timeout(
                    wait_timeout,
                    Arc::clone(&handle_store.semaphore).acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    Ok(Err(_)) => {
                        remove_handle(pool, handle_store).await;
                        continue;
                    }
                    Err(_) => return None,
                };
                return open_handle_channel(pool, handle_store, permit).await;
            } else {
                if let Ok(permit) = Arc::clone(&handle_store.semaphore).try_acquire_owned() {
                    return open_handle_channel(pool, handle_store, permit).await;
                }
            }
        }
        None
    };
    if let Some(channel) = try_open(None).await {
        return Some(channel);
    }
    // 没传超时时直接返回 None，避免再次无等待扫描。
    let wait_timeout = wait_timeout?;
    try_open(Some(wait_timeout)).await
}

/// 在扩容锁内增加一批 Handle，并把第一个 Handle 已创建的 Channel 直接交给调用方。
async fn grow_channel_pool(
    server_id: &str,
    pool: &InitializedChannelPool,
) -> Result<Option<(Channel<Msg>, OwnedSemaphorePermit)>, String> {
    let current_handles = current_pool_handle_count(pool).await;
    if current_handles >= pool.config.max_handles {
        return Ok(None);
    }

    let target_handles = pool.config.expanded_handle_count(current_handles);
    let mut added_handles = 0;
    let mut acquired_channel = None;

    while current_handles + added_handles < target_handles {
        match create_handle_store(server_id, pool.config.channels_per_handle).await {
            Ok((handle_store, channel)) => {
                if acquired_channel.is_none() {
                    // 先占用一个名额再发布 Handle，保证首个 Channel 也计入该服务器的单 Handle 上限。
                    let permit = Arc::clone(&handle_store.semaphore)
                        .try_acquire_owned()
                        .map_err(|_| "Channel池信号量初始化失败".to_string())?;
                    pool.handles.write().await.push(handle_store);
                    acquired_channel = Some((channel, permit));
                } else {
                    let _ = channel.close().await;
                    pool.handles.write().await.push(handle_store);
                }
                added_handles += 1;
            }
            Err(error) => {
                if acquired_channel.is_none() {
                    return Err(error);
                }
                warn!(
                    "服务器 {} 的 Channel 池未完成本轮扩容: {}",
                    server_id, error
                );
                break;
            }
        }
    }

    Ok(acquired_channel)
}

/// 从服务器池获取 Channel：优先复用、容量不足则扩容、达到上限后等待许可释放。
async fn acquire_pooled_channel(
    server_id: &str,
    pool: &InitializedChannelPool,
) -> Result<(Channel<Msg>, ChannelPoolPermit), String> {
    loop {
        if let Some(channel) = try_open_existing_channel(pool, None).await {
            return Ok(record_channel_acquired(pool, channel));
        }

        {
            let _resize_guard = pool.resize_lock.lock().await;
            // 等待扩容锁期间其他任务可能已经新增 Handle，先复查避免重复扩容。
            if let Some(channel) = try_open_existing_channel(pool, None).await {
                return Ok(record_channel_acquired(pool, channel));
            }
            if let Some(channel) = grow_channel_pool(server_id, pool).await? {
                return Ok(record_channel_acquired(pool, channel));
            }
        }

        // 池达到最大容量后等待一个名额；超时会回到循环并轮换 Handle。
        if let Some(channel) = try_open_existing_channel(pool, Some(HANDLE_WAIT_INTERVAL)).await {
            return Ok(record_channel_acquired(pool, channel));
        }
    }
}

/// 只有成功取得 Channel 后才更新活动时间与使用数，打开失败的尝试不会污染统计。
fn record_channel_acquired(
    pool: &InitializedChannelPool,
    acquired: (Channel<Msg>, OwnedSemaphorePermit),
) -> (Channel<Msg>, ChannelPoolPermit) {
    let (channel, permit) = acquired;
    pool.config
        .last_acquired_at
        .store(now_millis(), Ordering::Release);
    pool.current_channels.fetch_add(1, Ordering::AcqRel);
    (
        channel,
        ChannelPoolPermit {
            permit: Some(permit),
            current_channels: Arc::clone(&pool.current_channels),
        },
    )
}

/// 清理已经排空的缩容 Handle；返回要在锁外断开的 Handle，避免持锁执行网络操作。
async fn take_drained_handles(pool: &InitializedChannelPool) -> Vec<Arc<HandleStore>> {
    let mut handles = pool.handles.write().await;
    let mut drained = Vec::new();
    handles.retain(|handle| {
        let should_remove = handle.draining.load(Ordering::Acquire)
            && handle.semaphore.available_permits() == handle.capacity;
        if should_remove {
            drained.push(Arc::clone(handle));
        }
        !should_remove
    });
    drained
}

async fn disconnect_handles(handles: Vec<Arc<HandleStore>>) {
    for handle in handles {
        let _ = handle
            .handle
            .disconnect(Disconnect::ByApplication, "Channel pool closed", "")
            .await;
    }
}

/// 将可分配容量收回到服务器最小 Handle 数；忙碌的多余 Handle 先进入 draining。
async fn shrink_to_minimum(pool: &InitializedChannelPool) {
    let _resize_guard = pool.resize_lock.lock().await;
    let handles = pool.handles.read().await.clone();
    let mut allocatable_handles: Vec<_> = handles
        .iter()
        .filter(|handle| !handle.draining.load(Ordering::Acquire))
        .cloned()
        .collect();
    if allocatable_handles.len() <= pool.config.min_handles {
        return;
    }

    // 优先保留正在承载较多 Channel 的 Handle，尽可能让空闲 Handle 立即完成缩容。
    // 如果活跃 Channel 分散在多个 Handle 上，多余 Handle 只停止接新任务，绝不打断现有任务。
    allocatable_handles.sort_by_key(|handle| {
        Reverse(
            handle
                .capacity
                .saturating_sub(handle.semaphore.available_permits()),
        )
    });
    for handle in allocatable_handles
        .into_iter()
        .skip(pool.config.min_handles)
    {
        handle.draining.store(true, Ordering::Release);
    }
    disconnect_handles(take_drained_handles(pool).await).await;
}

/// 无获取活动且没有在用 Channel 时关闭池，并且只移除全局表中同一个池实例。
async fn close_inactive_pool(server_pool: &Arc<ServerChannelPool>) -> bool {
    let _lifecycle_guard = server_pool.lifecycle_lock.write().await;
    let Some(pool) = server_pool.initialized.get() else {
        return false;
    };
    let inactive_for =
        now_millis().saturating_sub(pool.config.last_acquired_at.load(Ordering::Acquire));
    if inactive_for < POOL_INACTIVE_CLOSE_AFTER.as_millis() as u64
        || server_pool.current_channels.load(Ordering::Acquire) != 0
    {
        return false;
    }

    server_pool.closed.store(true, Ordering::Release);
    {
        let mut pools = CHANNEL_POOL_STORE.write().await;
        let is_current_pool = pools
            .get(&server_pool.server_id)
            .is_some_and(|pool| Arc::ptr_eq(pool, server_pool));
        if is_current_pool {
            pools.remove(&server_pool.server_id);
        }
    }

    let handles = {
        let mut handles = pool.handles.write().await;
        std::mem::take(&mut *handles)
    };
    disconnect_handles(handles).await;
    true
}

/// 每个服务器池独立维护低负载计时和无活动回收，不创建全局轮询任务。
async fn maintain_server_pool(weak_pool: Weak<ServerChannelPool>) {
    let mut low_usage_since: Option<Instant> = None;
    loop {
        tokio::time::sleep(POOL_MAINTENANCE_INTERVAL).await;
        let Some(server_pool) = weak_pool.upgrade() else {
            return;
        };
        let Some(pool) = server_pool.initialized.get() else {
            continue;
        };

        // 上一轮标记为 draining 的 Handle 可能刚刚释放最后一个 Channel。
        disconnect_handles(take_drained_handles(pool).await).await;

        if server_pool.current_channels.load(Ordering::Acquire) < pool.config.min_channel_capacity()
        {
            let below_since = low_usage_since.get_or_insert_with(Instant::now);
            if below_since.elapsed() >= LOW_USAGE_SHRINK_AFTER {
                shrink_to_minimum(pool).await;
                // 已经触发本轮缩容；重新计时，避免每 5 秒重复排序同一批 Handle。
                low_usage_since = Some(Instant::now());
            }
        } else {
            low_usage_since = None;
        }

        let inactive_for =
            now_millis().saturating_sub(pool.config.last_acquired_at.load(Ordering::Acquire));
        if inactive_for >= POOL_INACTIVE_CLOSE_AFTER.as_millis() as u64
            && close_inactive_pool(&server_pool).await
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ChannelPoolConfig, ChannelPoolPermit, DEFAULT_CHANNELS_PER_HANDLE, MAX_MIN_HANDLES,
        MAX_POOL_HANDLES,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    #[test]
    fn pool_config_scales_with_cpu_count() {
        let small = ChannelPoolConfig::from_server_limits(1, DEFAULT_CHANNELS_PER_HANDLE);
        assert_eq!(small.min_handles, 1);
        assert_eq!(small.max_handles, 2);
        assert_eq!(small.expanded_handle_count(1), 2);

        let medium = ChannelPoolConfig::from_server_limits(8, DEFAULT_CHANNELS_PER_HANDLE);
        assert_eq!(medium.min_handles, 2);
        assert_eq!(medium.max_handles, 8);
        assert_eq!(medium.expanded_handle_count(2), 3);

        let large = ChannelPoolConfig::from_server_limits(32, DEFAULT_CHANNELS_PER_HANDLE);
        assert_eq!(large.min_handles, MAX_MIN_HANDLES);
        assert_eq!(large.max_handles, MAX_POOL_HANDLES);
        assert_eq!(large.expanded_handle_count(4), 5);
    }

    #[test]
    fn pool_config_keeps_handle_boundaries_and_minimum() {
        for cpu_count in 1..=64 {
            let config =
                ChannelPoolConfig::from_server_limits(cpu_count, DEFAULT_CHANNELS_PER_HANDLE);
            assert!((1..=MAX_MIN_HANDLES).contains(&config.min_handles));
            assert!(config.max_handles <= MAX_POOL_HANDLES);
            assert!(config.max_handles > config.min_handles);
        }

        let config = ChannelPoolConfig::from_server_limits(16, DEFAULT_CHANNELS_PER_HANDLE);
        assert_eq!(config.expanded_handle_count(1), config.min_handles);
    }

    #[test]
    fn pool_config_uses_server_channels_per_handle() {
        let config = ChannelPoolConfig::from_server_limits(8, 10);
        assert_eq!(config.channels_per_handle, 10);
        assert_eq!(config.min_handles, 1);
        assert_eq!(config.max_handles, 8);
        assert_eq!(config.min_channel_capacity(), 10);
        assert_eq!(config.expanded_handle_count(1), 2);
    }

    #[tokio::test]
    async fn channel_permit_releases_capacity_and_current_count() {
        let semaphore = Arc::new(Semaphore::new(1));
        let owned_permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let current_channels = Arc::new(AtomicUsize::new(1));
        let permit = ChannelPoolPermit {
            permit: Some(owned_permit),
            current_channels: Arc::clone(&current_channels),
        };

        assert_eq!(semaphore.available_permits(), 0);
        drop(permit);
        assert_eq!(semaphore.available_permits(), 1);
        assert_eq!(current_channels.load(Ordering::Acquire), 0);
    }
}
