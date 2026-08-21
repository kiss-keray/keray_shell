# 存储、文件系统、LVM 与 RAID

存储操作极易造成不可逆数据损失。本文默认只读诊断；清理、挂载、扩缩容、修复、分区、LVM/RAID 变更和块设备写入均须单独授权。

## 1. 第一轮：建立设备到挂载点的映射

```bash
# [R0] 容量、inode、块设备、挂载来源和选项。
df -hT
df -ih
lsblk -e7 -o NAME,MAJ:MIN,SIZE,TYPE,FSTYPE,FSVER,MOUNTPOINTS,UUID,ROTA,MODEL,SERIAL
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT
cat /proc/mdstat 2>/dev/null
```

变更前必须能回答：

- 目标是普通文件、挂载点、逻辑卷、RAID、multipath、云盘、网络盘还是容器 overlay。
- 设备名、UUID、文件系统、挂载点和业务数据归属如何对应。
- 是否存在 bind mount、快照、加密层、thin pool 或容器 volume。
- 是否生产、是否有冗余、备份是否可恢复、是否允许停机。

设备名如 `/dev/sdb` 可能变化；高风险操作优先用已经核对的 UUID、WWN、LVM 路径或稳定标识，并再次交叉验证容量和型号。

## 2. 容量与 inode

### 2.1 容量满

先限制在单一文件系统，避免跨网络盘、伪文件系统和独立挂载：

```bash
# [R1] 对大目录可能产生 IO；从已满挂载点的一层开始。
du -xhd1 <mountpoint> 2>/dev/null | sort -h
```

继续向最大的已确认子目录下钻，不要一开始运行 `du /` 或 `find /`。注意：

- ext 文件系统保留块、XFS allocation group、btrfs 元数据和快照会影响可用空间。
- 容器 overlay 的目录大小不能简单相加为物理占用。
- 稀疏文件的 apparent size 和实际块占用不同，可用 `du` 与 `du --apparent-size` 对比。

### 2.2 inode 满

```bash
# [R0] 先确认具体挂载点。
df -ih

# [R1] 仅扫描已确认的本地挂载点，可能产生大量目录访问。
find <mountpoint> -xdev -printf '%h\n' 2>/dev/null | sort | uniq -c | sort -nr | head -n 30
```

常见来源是 session、邮件队列、小日志、缓存、容器 layer 和异常临时文件。先确认生成者和保留策略，不直接批量删除。

## 3. `df` 与 `du` 不一致

按以下顺序排查：

1. 已删除但仍由进程打开的文件。
2. 目录被新挂载覆盖，底层旧文件仍占空间。
3. 快照、reflink、稀疏文件、预分配或文件系统元数据。
4. 容器 overlay/volume 的计量边界。
5. `du` 权限错误或未完成扫描。

```bash
# [R1] 输出可能包含敏感路径；按目标文件系统或进程进一步过滤。
lsof +L1 2>/dev/null
```

发现 deleted-open 文件后，释放方式通常是让持有进程正常重开日志或受控 reload/restart；不要对 `/proc/<pid>/fd/*` 盲目 truncate。服务变更按 R2/R3 走授权和验证。

## 4. IO 延迟与阻塞

```bash
# [R0] 先观察系统级队列和设备级指标。
vmstat 1 5
iostat -xz 1 5
pidstat -d 1 5
cat /proc/pressure/io 2>/dev/null
```

判读：

- `await` 是平均完成延迟，需结合设备类型、队列深度和历史基线。
- `%util` 在并行设备、NVMe 或虚拟设备上不能单独证明饱和。
- 进程 `D` 状态、IO pressure、应用延迟和内核错误一起看。
- 网络文件系统卡顿可能体现为本机 `D` 状态，但块设备指标不高。

进一步检查调度、SMART、云盘配额或存储阵列时，不做写入型 benchmark。`fio`、`dd` 写测试和 discard 属于 R3；即使指定“临时文件”也要先确认文件系统空间和业务影响。

## 5. 只读挂载、I/O error 与硬件迹象

```bash
# [R0]
findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS
journalctl -k -b --no-pager | grep -Ei 'i/o error|buffer i/o|read-only|remount|ext4|xfs|btrfs|nvme|ata|scsi|reset|timeout|medium error'
dmesg -T 2>/dev/null | tail -n 200
```

出现以下任一项时停止常规写操作并升级：

- `Buffer I/O error`、medium error、设备 reset/掉线。
- 文件系统因错误 remount read-only。
- RAID degraded 且另一个成员也有错误。
- SMART critical warning、pending/uncorrectable 持续增长。
- XFS shutdown、btrfs checksum error 或元数据损坏。

不要直接 remount 为读写、在线运行修复、反复重启或用清理空间掩盖硬件错误。先确定数据保护、故障域、冗余状态和停机恢复方案。

SMART 只读检查会因设备/控制器类型不同而不同：

```bash
# [R0] <disk> 必须是已核对的整盘设备，不是随意猜测的分区。
smartctl -x /dev/<disk>
nvme smart-log /dev/<nvme-device> 2>/dev/null
```

不要仅凭 `PASSED` 排除故障；结合错误计数趋势、内核日志、阵列/BMC/云平台事件。

## 6. 挂载与 `/etc/fstab`

挂载、卸载、remount 和修改 `fstab` 为 `[R3]`，可能阻塞进程、改变数据视图或导致下次无法启动。

只读预检：

```bash
# [R0]
findmnt --verify --verbose
findmnt -T <path>
fuser -vm <mountpoint> 2>/dev/null
systemctl list-dependencies --reverse <mount-unit> 2>/dev/null
```

变更前必须确认：

- 来源设备/网络端点和稳定标识正确。
- 目标目录原有内容是否会被挂载覆盖。
- 正在使用该挂载的进程和服务。
- `nofail`、`_netdev`、automount、超时和 systemd 依赖是否符合启动要求。
- 有控制台救援路径，并对 `fstab` 做过离线或 `findmnt --verify` 检查。

不要通过强制卸载解决未知占用；lazy/force unmount 会把错误延后或导致数据风险。

## 7. LVM、RAID 与 thin pool

只读盘点：

```bash
# [R0]
pvs -o+pv_uuid,pv_size,pv_free,vg_name 2>/dev/null
vgs -o+vg_uuid,vg_size,vg_free 2>/dev/null
lvs -a -o+lv_uuid,devices,data_percent,metadata_percent,segtype 2>/dev/null
mdadm --detail --scan 2>/dev/null
cat /proc/mdstat 2>/dev/null
```

安全边界：

- 不根据名称相似就选 PV/LV/阵列成员，必须映射到文件系统和业务。
- `pvmove`、`vgreduce`、`lvreduce`、RAID remove/add/reshape、thin repair 都是 R3，需专业 runbook 和可恢复备份。
- 扩容通常涉及“底层设备 → 分区/PV → LV → 文件系统”多层；每层确认实际大小和工具对文件系统的支持。
- 缩容风险远高于扩容；XFS 不支持缩小。无法证明支持时不要提供执行命令。
- thin pool data 或 metadata 接近 100% 可造成大范围故障；先停止增长并由存储负责人处理，不盲目创建快照。

## 8. 文件系统检查与修复

- 先识别准确 FSTYPE 和设备映射；ext、XFS、btrfs 的检查/修复工具不可混用。
- 对挂载中的文件系统只做文档明确支持的只读检查；实际修复通常需卸载或救援环境。
- `fsck -y`、`xfs_repair`、btrfs repair、journal 丢弃等属于 R3，可能丢文件或元数据；Agent 不自动执行。
- 先获取备份/镜像策略、停机许可、控制台和预计时长，再由有经验人员执行。
- 修复后还要验证文件级数据、应用一致性和备份，不以工具“完成”作为恢复成功。

## 9. 清理空间的安全流程

1. 确认已满挂载点和最低需要释放量。
2. 生成候选清单：路径、类型、属主、大小、mtime、打开状态和业务归属。
3. 优先使用应用自身的轮转、保留、purge 或归档机制。
4. 说明每个候选的预估收益、数据/审计风险和恢复方式。
5. 用户确认精确清单后才执行删除/压缩/截断；删除按 R3。
6. 清理后验证 `df`、inode、服务写入、日志链路和增长速度。

禁止直接清理：数据库数据/WAL、`/var/lib/docker` 或容器 runtime 根目录、持久卷、用户家目录、备份、审计日志、包数据库、正在写入的未知文件。

## 10. 必须停止的情况

- 目标设备、挂载点或文件系统类型不一致。
- 内核持续报告 I/O、checksum、reset 或只读错误。
- 唯一副本、备份不可验证或业务一致性未知。
- RAID/LVM/thin pool 状态异常且操作可能改变成员关系。
- 需要运行修复、缩容、格式化、覆盖恢复或未知来源脚本。

停止后报告设备映射、关键日志、当前只读状态、数据风险和需要的存储/硬件/业务负责人。
