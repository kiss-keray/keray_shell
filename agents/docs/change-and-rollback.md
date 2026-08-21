# 变更、回滚与验证

本文适用于配置文件、systemd、软件包、sysctl、limits、内核和重启相关操作。所有写操作仍须遵守 `../default.md` 的授权规则。

## 1. 变更包必须完整

执行前形成最小变更包：

```text
目标与环境：
问题和证据：
拟变更内容：
风险等级与影响面：
前置条件：
原状态/备份位置：
验证器与成功判据：
回滚步骤与触发条件：
观察时长与负责人：
```

缺少目标、授权、回滚或成功判据时，不执行 R2/R3。

## 2. 配置文件的安全修改

### 2.1 变更前

```bash
# [R0] 确认真实路径、挂载点、权限、时间和摘要。
readlink -f <config-path>
findmnt -T <config-path>
stat <config-path>
sha256sum <config-path>
```

检查文件是否由包、配置管理、容器镜像、secret 管理器或自动生成流程维护。受管理文件应修改权威来源，避免本机修改被覆盖。

### 2.2 备份要求

- 备份保留原属主、权限、ACL、扩展属性和 SELinux context；敏感配置的备份权限不得更宽。
- 备份放在同一受控文件系统或既定变更目录，文件名带 UTC 时间戳和变更标识。
- 记录摘要并确认可读；只复制但未核对不算完成。
- 不把含 secret 的配置复制到 `/tmp`、聊天或版本库。

示例仅在已授权后使用：

```bash
# [R2] <timestamp> 使用 UTC，例如 20260818T120000Z。
sudo cp --archive -- <config-path> <config-path>.bak.<timestamp>
sudo sha256sum -- <config-path> <config-path>.bak.<timestamp>
```

### 2.3 编辑与原子替换

- 优先 `sudoedit` 或在受控临时文件中编辑并校验；不要用无法审阅的大段 `sed -i`。
- 创建临时文件时使用 `umask 077`，保留目标模式/属主/context，再原子替换。
- 替换前比较 diff，确认没有格式化整文件、换行符或无关项变化。
- 配置包含 include 时同时检查实际加载路径和优先级。

### 2.4 先验证再加载

使用服务官方验证器；示例：

```bash
# [R0] 验证器可能需要读取受限 include，因此有时需要 sudo，但不应改变状态。
sudo nginx -t
sudo sshd -t
sudo visudo -cf /etc/sudoers
sudo systemd-analyze verify <unit-file>
```

验证器成功只证明语法或有限语义正确，不证明依赖、证书、端口和业务请求可用。

## 3. systemd 变更

### 3.1 先看真实生效配置

```bash
# [R0]
systemctl cat <service>
systemctl show <service> -p FragmentPath,DropInPaths,ExecStart,EnvironmentFiles,User,Group
systemctl list-dependencies <service> --all
```

优先使用 `/etc/systemd/system/<service>.d/*.conf` drop-in，不直接改包提供的 unit。创建 drop-in 是 `[R2]`，必须记录删除/恢复方式。

### 3.2 daemon-reload、reload 与 restart 不同

- `systemctl daemon-reload` 只让 systemd 重读 unit，不重启服务，但仍是状态变更 `[R2]`。
- `systemctl reload <service>` 让服务重载配置，是否无损由该服务决定，按 `[R2]`。
- `systemctl restart/stop <service>` 会中断进程和连接，按 `[R3]`。

执行 reload/restart 前确认：

- `ExecReload` 或服务文档支持的语义。
- 是否有多副本、负载摘除、连接 draining、启动依赖和冷启动时间。
- 配置验证通过、端口未冲突、证书/文件权限可读。
- 回滚后是否还需再次 daemon-reload/reload/restart。

### 3.3 验证

```bash
# [R0] 变更后立即检查 unit、日志和监听，再做业务健康检查。
systemctl is-active <service>
systemctl show <service> -p ActiveEnterTimestamp,MainPID,ExecMainStatus,Result,NRestarts
journalctl -u <service> --since '<change-time>' --no-pager -o short-iso
ss -lntup
```

不要因为 `is-active` 成功就结束；还要验证本机/负载均衡/真实依赖路径上的业务请求。

## 4. 软件包与仓库

### 4.1 变更前只读检查

```bash
# [R0] 选择目标系统适用的一组。
apt-cache policy <package> 2>/dev/null
dnf info <package> 2>/dev/null
rpm -q <package> 2>/dev/null
dpkg-query -W <package> 2>/dev/null
```

确认：目标版本、仓库来源、签名、依赖变化、配置文件策略、磁盘空间、服务脚本和是否需要重启。

### 4.2 边界

- 不默认执行全系统 upgrade、发行版升级、仓库替换或第三方安装脚本。
- 不用 `--allow-unauthenticated`、`--nogpgcheck` 等绕过签名验证作为修复。
- 安装/升级/降级/删除均为 `[R2]`；会自动重启服务、移除关键依赖或改变内核时升为 `[R3]`。
- 先使用包管理器的模拟/事务预览能力；认真检查将被移除的包和服务。
- 回滚需确认旧包仍可获得、数据格式是否向后兼容，不能只写“降级即可”。

## 5. sysctl、limits 与运行时参数

- 先读取当前值和来源，不根据网上“优化参数”批量套用。
- 临时写入 `/proc/sys` 或 `sysctl -w` 也是 `[R2]`；可能立即影响网络、内存或安全。
- 持久化前确定 `/etc/sysctl.conf` 与 `/etc/sysctl.d/*.conf` 的覆盖顺序。
- 对 `vm.*`、`kernel.*`、`net.*` 关键参数记录基线、单位、内核版本和观察指标。
- limits 可能来自 PAM、systemd unit、容器 runtime 或应用自身；只改 `/etc/security/limits.conf` 未必生效。

只读检查：

```bash
# [R0]
sysctl <key>
systemd-analyze cat-config sysctl.d 2>/dev/null
systemctl show <service> -p LimitNOFILE,LimitNPROC,TasksMax
cat /proc/<pid>/limits
```

## 6. 内核、引导与重启

内核安装、initramfs、bootloader、内核命令行和主机重启均按 `[R3]`。

执行前检查：

- 控制台/BMC/云串口是否可用，SSH 失败时谁能接管。
- 根文件系统、`/boot` 空间、磁盘/RAID 状态和目标内核文件是否完整。
- 默认引导项、Secure Boot/签名、DKMS/驱动兼容性。
- 业务是否已摘流，是否有 quorum、主从切换、未完成批处理和挂载依赖。
- 重启后网络、存储、时间同步、关键服务和业务健康检查顺序。
- 能否回到旧内核或旧引导项。

不要用重启来抹掉尚未保存的证据或暂时隐藏资源泄漏。

## 7. 回滚触发条件

变更前写出可观测阈值，例如：

- 配置验证失败或出现新 error 日志。
- 健康检查连续失败 `<N>` 次。
- 错误率、延迟、CPU、内存或连接失败超过基线/约定阈值。
- 新进程反复重启、无法监听、依赖不可达。
- 当前 SSH 会话异常或第二会话无法建立。

达到条件立即停止扩大发布并回滚；回滚本身也要验证。若回滚失败，不重复盲试，升级并保留当前状态。

## 8. 完成标准

变更只有在以下条件全部满足时才算完成：

1. 目标配置/版本/状态与计划一致。
2. 技术健康检查和业务健康检查通过。
3. 关键指标在观察窗口内稳定，无新错误。
4. 批量目标逐台有结果，失败项已隔离。
5. 备份、临时文件、计划回滚任务和残余风险已登记。
6. 实际动作、时间、操作者、证据和回滚状态已报告。
