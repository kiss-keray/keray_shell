---
name: disk-check
description: 专业排查 Linux 磁盘容量、inode、目录占用、已删未释放文件、IO 延迟、只读挂载、文件系统、挂载链路、LVM/MD RAID、SMART 与 NVMe 健康问题。用户提到磁盘满、ENOSPC、写不进去、空间突然消失、IO 高、I/O error、磁盘掉线或文件系统只读时使用。
---

# 技能：Linux 磁盘运维

本技能只用于 Linux 主机的磁盘、块设备、文件系统和挂载链路运维。目标不是简单给出“删文件或重启”的建议，而是建立以下完整映射并给出证据化结论：

```text
业务路径 → 挂载点 → 文件系统 → 分区/LV/RAID/加密层 → 块设备 → 物理盘或云盘
```

适用范围：

- 容量、inode、预留空间、目录和大文件定位。
- 已删除但仍被进程打开的文件、挂载覆盖、快照和 `df/du` 差异。
- IO 延迟、吞吐、队列、IO pressure、阻塞进程和内核错误。
- ext4、XFS、btrfs 等文件系统的只读、损坏和挂载异常判断。
- LVM、LVM thin pool、Linux MD RAID、SMART、SATA/SAS/NVMe 健康盘点。
- 本机盘、虚拟盘、云盘和网络文件系统的主机侧定位。

不自动处理数据库逻辑一致性、Kubernetes PV/CSI 控制面、SAN/云平台控制面或厂商阵列变更；发现问题可定位到对应层并升级给负责人。

## 1. 专业安全边界

### 1.1 默认只观察

- 本技能默认只执行 R0/R1 诊断。R1 命令必须限制挂载点、时长、输出数量和并发。
- 只读不等于无风险：全盘 `du/find`、SMART 长测、抓取大量日志和高频监控都可能增加 IO 或暴露路径信息。
- 先查文件系统是否只读、内核是否有 I/O error、设备是否掉线；存在硬件/元数据风险时，不再做大范围扫描。

### 1.2 必须授权的操作

以下操作不得自动执行：

- 删除、压缩、truncate、移动业务文件或修改日志保留策略。
- restart/stop 服务以释放文件，kill 进程，卸载、挂载或 remount。
- `fstrim`、写入型 `fio/dd`、分区、格式化、扩缩容、LVM/RAID 成员变更。
- `fsck`、`xfs_repair`、btrfs repair、journal 丢弃和任何文件系统写修复。
- 云盘扩容、快照恢复、覆盖恢复和持久卷操作。

需要这些动作时先调用 `load_doc_body` 加载：

- `docs/safety-and-authorization.md`
- `docs/change-and-rollback.md`
- `docs/storage-and-filesystem.md`

然后给出精确目标、风险、预检、备份/恢复状态、回滚和成功判据，获得针对单一步骤的明确确认。

### 1.3 设备确认规则

任何 R2/R3 存储操作前，至少用四项信息交叉确认目标：稳定设备标识（UUID/WWN/serial/LV path）、容量、文件系统/层级、挂载点与业务归属。不能只凭 `/dev/sdX`、`/dev/nvmeXnY` 名称或“看起来大小相同”选设备。

## 2. 先确认症状与目标

优先使用用户已经提供的事实，不重复索要相同输出。尽量确定：

- 报错原文和 errno，例如 `No space left on device`、`Disk quota exceeded`、`Read-only file system`、`Input/output error`。
- 受影响路径、挂载点、设备、服务和开始时间。
- 是无法新建文件、无法追加、延迟升高、设备消失，还是监控容量告警。
- 是否生产、是否仍在写入、是否有冗余/备份、能否接受性能影响或停机。
- 最近是否扩容、重启、迁移、改挂载、做快照、更新内核或发生异常断电。

不要把所有“写失败”都归因于空间：quota、只读挂载、权限、inode、文件大小限制、IO error 和应用自身限制会出现相似症状。

## 3. 第一轮快速分诊

### 3.1 未知具体路径时

```bash
# [R0] 获取容量、inode、设备层级与挂载选项；不修改状态。
date -Is
df -hT
df -ih
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT
lsblk -e7 -o NAME,MAJ:MIN,SIZE,TYPE,FSTYPE,FSVER,MOUNTPOINTS,UUID,ROTA,MODEL,SERIAL
```

### 3.2 已知报错路径时

```bash
# [R0] <path> 必须替换成实际路径；优先精确映射，不扫无关磁盘。
findmnt -T <path> -o TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT
df -hT <path>
df -ih <path>
stat -f <path>
```

### 3.3 根据证据分流

| 证据                                             | 初步分类                             | 下一节        |
| ------------------------------------------------ | ------------------------------------ | ------------- |
| blocks 可用量低、`Use%` 高                       | 容量压力                             | 第 4 节       |
| inode 可用量低、块空间仍足                       | inode 耗尽                           | 第 5 节       |
| `df` 高但 `du` 明显偏低                          | deleted-open、挂载覆盖、快照或保留块 | 第 6 节       |
| `await`/IO pressure/业务延迟持续高               | IO 延迟或饱和                        | 第 7 节       |
| `ro`、I/O error、reset、checksum、设备消失       | 文件系统或设备故障                   | 立即看第 8 节 |
| RAID degraded、thin pool 高水位、SMART/NVMe 告警 | 存储栈或硬件风险                     | 第 9 节       |
| 挂载点缺失、启动后未挂载                         | 挂载链路                             | 第 10 节      |

`Use%` 不能单独决定严重程度。必须同时考虑绝对剩余字节、inode、增长速度、日志/数据库预留、文件系统保留块、快照和业务写入速率。大盘 90% 与小分区 90% 的紧迫程度不同。

## 4. 容量与目录占用

### 4.1 精确确认空间

```bash
# [R0] 使用字节口径便于计算剩余量和释放目标。
df -B1 -T <mountpoint>
findmnt -T <mountpoint> -o TARGET,SOURCE,FSTYPE,OPTIONS
```

先根据增长速度估算安全释放目标，不只追求“低于 90%”。应给业务保留足够写入窗口和应急余量。

### 4.2 只扫描异常文件系统

```bash
# [R1] 可能产生明显 IO；只扫描已确认的本地挂载点并停留在第一层。
du -xhd1 <mountpoint> 2>/dev/null | sort -hr | head -n 30
```

只对最大的已确认子目录继续下一层：

```bash
# [R1] <largest-directory> 必须位于同一异常文件系统。
du -xhd1 <largest-directory> 2>/dev/null | sort -hr | head -n 30
```

寻找大文件时先设合理阈值，输出清单而不删除：

```bash
# [R1] 示例阈值为 1 GiB；按实际容量调整，扫描大文件系统可能较慢。
find <mountpoint> -xdev -type f -size +1G -printf '%s\t%TY-%Tm-%TdT%TH:%TM:%TS\t%u\t%p\n' 2>/dev/null \
  | sort -nr -k1,1 | head -n 50
```

注意：

- `-x`/`-xdev` 防止跨文件系统，但扫描根文件系统本身仍可能很重。
- NFS/CIFS/FUSE/ceph 等网络或用户态文件系统先确认影响，不套用本地盘扫描方式。
- `du` 是已分配块，`du --apparent-size` 是逻辑大小；稀疏文件两者可能差异巨大。
- btrfs reflink/快照、容器 overlay、硬链接会使目录大小和可回收空间难以直接对应。

### 4.3 按文件系统校正容量判断

先用 `findmnt` 确认 FSTYPE，只运行对应的一组只读命令：

```bash
# [R0/R1] ext2/3/4：读取 superblock 统计；<block-device> 必须先映射确认。
tune2fs -l /dev/<block-device> 2>/dev/null \
  | grep -Ei 'block count|free blocks|reserved block count|block size|filesystem state'
```

```bash
# [R0] XFS：查看几何信息；quota 报告仅在已启用时有意义。
xfs_info <mountpoint> 2>/dev/null
xfs_quota -x -c 'report -h' <mountpoint> 2>/dev/null
```

```bash
# [R0/R1] btrfs：分别检查 data、metadata、system chunk 和设备分配。
btrfs filesystem usage -T <mountpoint> 2>/dev/null
btrfs filesystem df <mountpoint> 2>/dev/null
```

判读边界：

- ext 保留块可能导致普通用户先于 root 遇到 ENOSPC；不要未经评估就把保留比例调为 0。
- XFS 空间充足但写入失败时检查 user/group/project quota；不能用 `df` 排除配额问题。
- btrfs 的 data 与 metadata 任一空间紧张都可能导致写入失败；不要因设备总剩余量看似足够就直接 balance。
- tmpfs 使用的是内存/swap 配额，不是物理磁盘容量；转入内存与 mount size 判断。
- overlay 的 writable layer 最终落在 backing filesystem；应映射容器 layer/volume 到宿主机挂载点，禁止直接删除 runtime 数据目录。

### 4.4 quota 分支

报错为 `Disk quota exceeded`，或仅特定用户/项目不能写时，优先检查 quota：

```bash
# [R0] 工具和 quota 类型因文件系统而异；只查询已确认的用户和挂载点。
quota -u <user> 2>/dev/null
repquota <mountpoint> 2>/dev/null
```

确认是 user、group、project quota、文件数限制还是块数限制。提高/关闭 quota 属于 R2/R3，必须由资源所有者确认配额策略，不能用临时放宽掩盖异常增长。

## 5. inode 耗尽

先确认具体文件系统，而不是固定扫描 `/var`：

```bash
# [R0]
df -ih <mountpoint>
```

GNU coreutils 支持时优先按目录统计 inode：

```bash
# [R1] 会遍历目标文件系统；仅在 inode 问题已确认时执行。
du --inodes -x -d1 <mountpoint> 2>/dev/null | sort -nr | head -n 30
```

无 `du --inodes` 时再使用兼容性较低、成本更高的回退：

```bash
# [R1] GNU findutils；输出 inode 数最多的父目录。
find <mountpoint> -xdev -printf '%h\n' 2>/dev/null \
  | sort | uniq -c | sort -nr | head -n 30
```

常见来源：session、小日志、邮件队列、缓存、监控落盘、异常 core、容器 layer。必须先确认生成者、保留策略和是否仍被使用，不按扩展名或 mtime 直接批量删除。

## 6. `df` 与 `du` 不一致

按以下顺序排查：

1. 已删除但进程仍持有的文件。
2. 新挂载覆盖了目录中的旧文件。
3. ext 保留块、快照/reflink、稀疏或预分配文件。
4. btrfs/LVM/ZFS/云盘快照与容器 overlay 计量边界。
5. `du` 权限不足、扫描未完成或路径不在同一文件系统。

### 6.1 已删除但仍占空间

```bash
# [R1] 可能暴露进程、用户和业务路径；先限定主机和输出范围。
lsof -nP +L1 2>/dev/null
```

输出中重点确认进程、PID、FD、文件大小、设备号和 deleted 路径，再映射回 systemd unit/cgroup。不要操作 `/proc/<pid>/fd/*`，不要对 fd 盲目 truncate。

释放空间的优先顺序：应用官方日志 reopen/rotate → 经验证的 reload → 有冗余和授权时 restart。发信号、reload 或 restart 前必须确认服务支持方式、业务影响和成功判据，不能仅凭 PID 猜测信号。

### 6.2 挂载覆盖

```bash
# [R0] 查看目标及下级挂载，确认是否有目录被覆盖。
findmnt -R <mountpoint> -o TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT
```

不要为查看底层目录而直接卸载生产挂载；卸载属于 R3，应在停机或独立 namespace/救援方案中设计。

## 7. IO 延迟、饱和与阻塞

### 7.1 系统和设备指标

```bash
# [R0] 5 个一秒样本，观察 runnable、blocked、IO wait 和 swap 活动。
vmstat 1 5
cat /proc/pressure/io 2>/dev/null
```

```bash
# [R0] 需要 sysstat；观察设备队列、延迟、吞吐和进程 IO。
iostat -xz 1 5
pidstat -d 1 5
```

工具不存在时先报告缺失，不自动安装：

```bash
# [R0]
command -v iostat pidstat iotop smartctl nvme
```

### 7.2 现代指标判读

- `await`、`r_await`、`w_await`：完成延迟，需结合介质类型和历史基线。
- `aqu-sz`：平均队列长度；持续增长通常比单次尖峰更值得关注。
- `r/s`、`w/s`、`rkB/s`、`wkB/s`：负载形态和吞吐，不等于好坏。
- `%util`：HDD 上较有参考价值；NVMe、RAID、虚拟盘和并行设备不能仅凭接近 100% 判定饱和。
- `/proc/pressure/io`：任务因 IO 等待而受阻的比例，需结合业务延迟。
- `vmstat` 的 `b/wa`、D 状态进程、内核 reset/timeout 与应用超时要一起看。

`svctm` 已在新版 sysstat 中移除或不可靠，不用它作为结论依据。

### 7.3 找阻塞任务

```bash
# [R0] 仅显示 D 状态任务；仍需确认它等待的是本地盘、网络盘还是内核资源。
ps -eo state,pid,ppid,user,wchan:32,etimes,comm,args \
  | awk 'NR==1 || $1 ~ /^D/'
```

`iotop`、`strace`、`perf` 和高频采样按 R1，必须限定 PID、时长和输出。禁止在生产数据盘上用写入型 `fio` 或 `dd` 测速；测试文件也可能占满空间、击穿缓存或破坏数据。

## 8. 只读挂载、I/O error 与文件系统异常

```bash
# [R0] 先确认实际挂载选项和文件系统类型。
findmnt -T <path> -o TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT
```

```bash
# [R0] 按故障时间缩小内核日志；<start-time> 使用明确时间。
journalctl -k -b --since '<start-time>' --no-pager -o short-iso \
  | grep -Ei 'i/o error|buffer i/o|read-only|remount|ext4|xfs|btrfs|nvme|ata|scsi|reset|timeout|medium error|checksum|blk_update'
```

出现以下任一情况立即停止常规写操作和大范围扫描：

- 文件系统 remount read-only、XFS shutdown 或 btrfs checksum/metadata error。
- `Buffer I/O error`、medium error、NVMe critical warning、设备 reset/掉线。
- 多个进程长期 D 状态且内核同时报告存储错误。
- 同一 RAID/thin pool 多处异常，或备份状态未知。

禁止直接 remount 为读写、在线写修复、反复重启、`fsck -y` 或用清空间掩盖硬件错误。先保护数据，确认备份/冗余和停机恢复方案，再加载 `docs/storage-and-filesystem.md`。

权限不足导致 `dmesg`/journal 无输出时，只能报告“无法读取”，不能推断没有内核错误。

## 9. SMART、NVMe、MD RAID 与 LVM

### 9.1 设备与物理健康

```bash
# [R1] <disk> 必须由 lsblk/挂载映射确认；读取 SMART 可能唤醒休眠盘并暴露设备序列号。
smartctl -x /dev/<disk>
```

```bash
# [R0] NVMe 工具存在时使用；控制器与 namespace 设备名需先确认。
nvme smart-log /dev/<nvme-device>
nvme error-log /dev/<nvme-device> --log-entries=16
```

判读规则：

- SMART `PASSED` 不能单独排除故障；结合内核日志、趋势、介质错误、pending/uncorrectable 和设备 reset。
- HDD 的 reallocated/pending/uncorrectable 关注是否增长；单一原始值需结合厂商语义。
- SATA CRC error 更可能是链路/线缆/背板，但仍需结合趋势和 reset。
- NVMe 关注 critical warning、media/data integrity errors、error log、temperature 和 percentage used。
- 硬 RAID/HBA/USB bridge 可能需要 `smartctl -d` 或厂商工具；不能因普通命令读不到就判定健康。
- SMART self-test 可能持续很久并增加设备负载，按 R1，未评估前不启动。

### 9.2 MD RAID 与 LVM

```bash
# [R0]
cat /proc/mdstat 2>/dev/null
mdadm --detail --scan 2>/dev/null
pvs -o+pv_uuid,pv_size,pv_free,vg_name 2>/dev/null
vgs -o+vg_uuid,vg_size,vg_free 2>/dev/null
lvs -a -o+lv_uuid,devices,data_percent,metadata_percent,segtype 2>/dev/null
```

发现 RAID degraded、recovery 异常、PV missing、thin pool data/metadata 高水位时立即升级。不要自动 add/remove/replace、`pvmove`、`vgreduce`、`lvreduce`、thin repair 或创建更多快照。

## 10. 挂载点缺失或挂载失败

```bash
# [R0]
findmnt --verify --verbose
lsblk -f
systemctl --failed --no-pager 2>/dev/null
journalctl -b --no-pager -o short-iso \
  | grep -Ei 'mount|dependency failed|timed out|wrong fs type|bad superblock|unknown filesystem'
```

确认是本地盘、网络盘、automount、加密卷还是 systemd mount unit，并检查稳定标识、依赖和超时。不要直接修改 `/etc/fstab` 或手动 mount 试错；错误设备、错误挂载点或覆盖已有目录都可能导致数据风险。

## 11. 安全清理流程

清理前必须产出候选清单，而不是直接给删除命令。每个候选至少包含：

- 绝对路径、所在挂载点、文件类型、属主/权限。
- 实际占用、文件数量、mtime 范围、是否仍被打开或写入。
- 生成者、保留策略、业务/审计价值和可恢复来源。
- 预计可释放空间、操作风险、回滚或恢复方式。

清理优先级：

1. 使用应用自身支持的轮转、归档、retention 或 purge 机制。
2. 清理明确可重建、已过期且有权威策略的缓存或临时数据。
3. 经业务确认后处理旧版本、旧构建物或已归档数据。
4. 数据库目录、容器 runtime 根目录、volume、用户家目录、备份和审计日志只升级，不直接建议删除。

以下只读命令可帮助评估候选：

```bash
# [R0/R1] 仅查看占用；根据目录规模决定是否为 R1。
journalctl --disk-usage
du -sh /var/log /var/cache /tmp 2>/dev/null
```

`journalctl --vacuum-*`、包缓存 clean、logrotate 强制轮转、truncate、删除和服务 restart 都是变更。必须先说明保留影响和实际收益，经授权后单独执行。不要直接删除 `/var/lib/docker`、`/var/lib/containerd`、数据库 WAL/binlog、活跃日志、备份或未知大文件。

## 12. 扩容、修复与恢复的门禁

遇到扩容、缩容、分区、LVM、RAID、文件系统 repair 或备份恢复时，本技能只负责收集映射和风险，不自动给出可执行写命令，直到满足：

1. 设备层级、文件系统类型、当前大小和目标大小已交叉验证。
2. 已确认工具和文件系统版本支持该方向；例如 XFS 不支持缩小。
3. 业务停写/停机、冗余、备份可恢复性和控制台路径明确。
4. 每一层的操作顺序、失败停止点、回滚/恢复方案和预计耗时明确。
5. 用户对当前单一步骤给出精确授权。

## 13. 修复后验证

修复或清理后不能只看命令退出码，至少验证：

- `df -hT`、`df -ih` 的目标挂载点和可用量符合预期。
- `findmnt` 的来源、文件系统和选项未发生意外变化。
- 服务能够创建、写入、同步和读取目标数据，真实业务健康检查通过。
- 内核日志没有新的 I/O、reset、checksum、只读或文件系统错误。
- IO latency、pressure、队列和业务延迟回到合理范围。
- 空间/inode 增长速度已受控，清理不是短期掩盖。
- RAID/LVM/SMART/NVMe 状态稳定，备份与监控恢复正常。

## 14. 强制停止与升级条件

遇到以下情况立即停止写操作，明确告知用户数据风险：

- 目标设备、挂载点、文件系统或业务归属无法一致确认。
- I/O error、只读 remount、checksum、设备 reset/掉线仍在持续。
- RAID/LVM/thin pool 异常可能影响多个数据层。
- 唯一数据副本、备份不可验证或恢复路径不明确。
- 需要 fsck/repair、缩容、格式化、覆盖恢复或厂商专用工具。
- 当前操作可能影响集群 quorum、数据库一致性、容器 volume 或唯一 SSH/控制台路径。

升级报告必须给出：路径到设备的映射、故障开始时间、关键内核日志、容量/inode/IO 指标、冗余与备份状态、已经执行的只读检查以及建议负责人。

需要生成最终诊断结论时，再读取 [references/output-format.md](references/output-format.md) 统一输出格式；排查过程中无需提前加载。
