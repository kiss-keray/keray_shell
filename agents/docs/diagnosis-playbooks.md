# 通用 Linux 排障路径

本文用于建立事实基线和选择下一条最有价值的只读检查。不要把所有命令一次性运行；按症状逐层缩小。

## 1. 排障原则

- 先定义“异常”：影响对象、开始时间、频率、期望值和实际值。
- 同时看资源饱和、错误、延迟与最近变更，避免只看瞬时 CPU 百分比。
- 保留时区和时间范围；对比应用、系统、监控和用户时间线。
- 先检查最靠近症状的一层，再沿依赖向下：业务请求 → 进程/服务 → 操作系统 → 网络/存储 → 外部依赖。
- 没有基线时不要仅凭一个阈值下结论；结合持续时间、队列、错误和历史水平。

## 2. 最小基线

以下通常是 `[R0]`；在容器、精简系统或非 systemd 环境中允许部分命令不存在。

```bash
date -Is
hostnamectl 2>/dev/null || hostname
id
cat /etc/os-release 2>/dev/null
uptime
free -h
df -hT
df -ih
systemctl --failed --no-pager 2>/dev/null
```

基线只回答“系统现在大致怎样”。不要看到负载高就立即重启；先确认负载来源以及它是 CPU runnable 还是不可中断 IO。

## 3. CPU、load 与调度

### 3.1 最小检查

```bash
# [R0] 5 个一秒样本，观察 runnable、blocked、CPU 与 swap 活动。
vmstat 1 5
ps -eo pid,ppid,user,stat,etimes,%cpu,%mem,comm,args --sort=-%cpu | head -n 25
nproc
```

判读要点：

- load average 是可运行和不可中断任务数量，不等于 CPU 使用率。
- `r` 持续显著高于可用 CPU 且 `us/sy` 高，较像 CPU 饱和。
- `b`、`wa` 高或进程状态 `D` 多，优先查 IO、NFS、块设备或内核等待。
- 单进程 100% 通常表示占满一个逻辑 CPU，不代表整机满载。
- 虚拟机还要关注 steal time；容器内 CPU 数和配额可能与宿主机不同。

### 3.2 深入检查

`pidstat`、`mpstat` 不一定已安装；先检查工具是否存在。

```bash
# [R0] 观察线程/进程和每 CPU 分布。
pidstat -u -t 1 5
mpstat -P ALL 1 5
```

`perf`、持续 `strace` 和性能剖析按 `[R1]`，先限定 PID、频率和时长，并评估生产开销。

## 4. 内存、swap 与 OOM

```bash
# [R0] 区分 available、cache、swap 和内核内存。
free -h
grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree|Slab|SReclaimable|Dirty|Writeback' /proc/meminfo
vmstat 1 5
ps -eo pid,ppid,user,rss,vsz,%mem,etimes,comm,args --sort=-rss | head -n 25
journalctl -k -b --no-pager | grep -Ei 'out of memory|oom-killer|killed process' | tail -n 50
```

判读要点：

- Linux 使用空闲内存做 page cache；`free` 很低不等于内存泄漏，优先看 `MemAvailable`。
- 持续 `si/so`、延迟上升和 swap 接近耗尽比“用了 swap”本身更重要。
- OOM 日志要确认被杀进程、cgroup、时间和触发约束；容器 OOM 不一定是整机内存耗尽。
- 不在未定位根因时执行 drop cache、关闭 swap 或临时加大 overcommit；这些是 R2/R3 变更且可能掩盖问题。

若怀疑泄漏，记录同一进程的 PID 启动时间、RSS/PSS 随时间趋势和业务负载；一次快照不能证明泄漏。读取全量 `smaps` 或生成 heap dump 按 `[R1]`。

## 5. 进程与 systemd 服务

### 5.1 服务状态

```bash
# [R0] <service> 必须替换成已确认的 unit。
systemctl status <service> --no-pager -l
systemctl show <service> -p Id,LoadState,ActiveState,SubState,Result,MainPID,ExecMainStatus,NRestarts,FragmentPath,DropInPaths
systemctl cat <service>
journalctl -u <service> --since '<start-time>' --until '<end-time>' --no-pager -o short-iso
```

注意：

- `active (running)` 只证明 systemd 认为主进程存在，不代表端口、依赖和业务健康。
- `status=203/EXEC` 常与路径、权限、解释器或 SELinux/AppArmor 有关。
- 快速重启要看 `NRestarts`、退出码、启动限制和最早一条失败日志，而不是只看最后一行。
- `systemctl cat` 展示 vendor unit 与 drop-in；不要只编辑 `/usr/lib/systemd/system` 或 `/lib/systemd/system` 的包管理文件。

### 5.2 确认进程归属

```bash
# [R0] 在发送信号前重新核对，防止 PID 复用。
ps -p <pid> -o pid,ppid,user,lstart,stat,etimes,cmd
cat /proc/<pid>/cgroup 2>/dev/null
readlink -f /proc/<pid>/exe 2>/dev/null
```

打开文件、socket 和进程树可能产生较多输出；按 PID 限定：

```bash
# [R1] 可能暴露路径、连接和业务元数据。
lsof -nP -p <pid>
```

## 6. 日志与内核线索

先限定 unit、boot、priority 和时间，避免全量导出：

```bash
# [R0] 当前启动、warning 以上、最近 200 行。
journalctl -b -p warning..alert -n 200 --no-pager -o short-iso
journalctl -k -b -n 200 --no-pager -o short-iso
journalctl --disk-usage
```

排查规则：

- 从第一条异常向前看上下文，不只抓取 `error` 字样。
- 保留原始时间、unit、PID 和退出码；应用日志和内核日志需对齐时区。
- 日志缺失可能是轮转、速率限制、权限、持久化未开启或服务写到别处，不等于事件未发生。
- 不用 `journalctl --vacuum-*`、truncate 或删除日志作为排障动作。

## 7. 启动、关机与重启历史

```bash
# [R0] 判断本次启动时间、异常关机和内核版本。
who -b
uptime -s
last -x | head -n 30
uname -a
journalctl --list-boots --no-pager
```

如果最近发生异常重启，检查上一 boot 的尾部日志：

```bash
# [R0] 前提：journald 保留了上一 boot。
journalctl -b -1 -e --no-pager
```

不要仅凭 `last` 中的 `crash` 确认硬件故障；结合内核、BMC/云平台事件和电源记录。

## 8. 时间、NTP 与证书

时间漂移会表现为 TLS、认证、日志乱序和集群租约问题。

```bash
# [R0]
date -Is
timedatectl status 2>/dev/null
timedatectl timesync-status 2>/dev/null
chronyc tracking 2>/dev/null
```

证书只读检查：

```bash
# [R0] 明确 SNI 与目标端口；设置连接超时，避免挂起。
timeout 10 openssl s_client -connect <host>:<port> -servername <dns-name> </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -serial -dates -ext subjectAltName
```

不要在输出中展示私钥，也不要用跳过证书验证作为永久修复。

## 9. DNS、网络和存储分流

- 连接失败、超时、丢包、DNS 或 SSH 问题：转 `network-and-remote-access.md`。
- `df`、inode、IO、只读挂载、I/O error：转 `storage-and-filesystem.md`。
- 容器内外状态不一致：转 `containers.md`。
- 未知用户、异常登录、可疑进程或日志被改：转 `incident-response.md`。

## 10. 输出结论的最低证据

每个结论至少说明：

1. 观察时间和目标。
2. 支持结论的输出字段或日志事件。
3. 与用户症状的因果联系。
4. 尚未排除的替代解释。
5. 下一条能证伪当前假设的检查。

不要仅凭相关性宣布根因；修复后症状消失也要验证关键指标并观察是否复发。
