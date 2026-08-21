# 账户、权限、sudo 与定时任务

身份和权限变更可能造成越权、锁死管理员或持久化后门。新增/删除账户、sudo/PAM/SSH key 变更、递归权限和生产定时任务默认按 R3；普通应用文件的精确可回滚权限修正可按 R2。

## 1. 先确认身份来源

账户可能来自本地 `/etc/passwd`、LDAP/AD/SSSD、容器镜像或其他 NSS provider。不要只查本地文件就断言账户不存在。

```bash
# [R0]
getent passwd <user>
id <user>
getent group <group>
getent ahosts <identity-provider-host> 2>/dev/null
```

诊断登录还要区分：账户解析、密码/密钥认证、PAM、shell、home、SELinux/AppArmor、sudo 和目标服务自身授权。

## 2. 账户生命周期

创建、锁定、解锁、过期、改 shell、改组和删除账户前确认：

- 账户所有者、用途、审批、环境和有效期限。
- UID/GID 是否与共享存储、容器或集中目录冲突。
- 正在运行的进程、定时任务、文件、会话、密钥和服务依赖。
- 是停止交互登录，还是同时停止服务访问；二者不能混为一谈。
- 回滚时如何恢复原组、shell、过期时间和认证材料。

只读盘点：

```bash
# [R0]
getent passwd <user>
id <user>
chage -l <user> 2>/dev/null
loginctl user-status <user> 2>/dev/null
ps -u <user> -o pid,ppid,lstart,stat,cmd
```

不要直接删除仍拥有业务文件或运行服务的账户。不要复用已有 UID/GID。紧急禁用可影响自动化和服务，应与事件负责人确认并按事件响应流程记录。

## 3. 文件权限与 ACL

### 3.1 诊断实际访问路径

```bash
# [R0] 检查路径每一级目录的权限和最终对象。
namei -l <path>
stat <path>
getfacl -p <path> 2>/dev/null
lsattr -d <path> 2>/dev/null
findmnt -T <path>
```

权限失败还可能来自：只读挂载、SELinux/AppArmor、systemd sandbox、容器 user namespace、NFS root squash、immutable 属性或应用 umask。

### 3.2 修改边界

- 不建议 `chmod -R 777`、全局关闭 MAC 策略或把应用改为 root。
- 递归 `chown/chmod/setfacl` 按 R3；先生成清单并确认不会跨挂载、符号链接和不相关数据。
- 精确修复应描述期望 owner/group/mode/ACL 的来源，不凭“常见值”猜测。
- 修改前保存 `stat`、ACL、扩展属性和 SELinux context；回滚必须恢复这些维度。
- 目录 execute 权限、setgid/sticky bit、default ACL 和应用 umask 要一起考虑。

只读查看 SELinux/AppArmor：

```bash
# [R0]
getenforce 2>/dev/null
ls -lZ <path> 2>/dev/null
ausearch -m AVC -ts recent 2>/dev/null | tail -n 50
aa-status 2>/dev/null
```

先创建精确策略或恢复正确 label，不用 `setenforce 0`、停用 profile 或永久关闭安全模块作为修复。

## 4. sudo

```bash
# [R0] 只查看当前主体被授予的能力；输出可能包含安全敏感的命令范围。
sudo -l
sudo visudo -c
```

安全要求：

- 使用 `/etc/sudoers.d/<purpose>` 的最小规则，明确用户/组、主机、run-as 和命令绝对路径。
- 避免允许可逃逸到 shell 的编辑器、解释器、包管理器或带任意参数的通配规则。
- 不为方便而添加 `NOPASSWD: ALL`。
- 修改前保留当前 root/管理员恢复路径；使用 `visudo -cf <file>` 验证后再安装。
- 不在当前任务中通过修改 sudoers 来绕过本来没有的操作权限。

## 5. SSH authorized_keys

只读检查应避免输出完整公钥注释中的个人信息，可报告 fingerprint、类型、选项和数量：

```bash
# [R0] 在受控终端执行；<authorized-keys-file> 必须先确认。
ssh-keygen -lf <authorized-keys-file>
stat <authorized-keys-file>
```

新增/移除 key 为 R3：

- 核验 key fingerprint、所有者、来源、用途、有效期和审批。
- 使用最小限制选项，如适用可限制来源、命令、PTY 和转发能力。
- 先备份权限/属主，保持 `.ssh` 和 `authorized_keys` 的严格权限。
- 新增时先验证第二会话；移除前确认不是唯一恢复路径。
- 发现未知 key 时不要立即删除并结束；先按安全事件保留证据、确认会话和影响面。

## 6. cron、systemd timer 与一次性任务

### 6.1 盘点

```bash
# [R0]
systemctl list-timers --all --no-pager
crontab -l 2>/dev/null
ls -la /etc/cron.d /etc/cron.hourly /etc/cron.daily 2>/dev/null
atq 2>/dev/null
```

还要检查用户 crontab、`/etc/crontab`、anacron、systemd user timer 和应用内部调度。查看其他用户内容可能需要权限且含敏感命令，按最小范围处理。

### 6.2 新建或修改

- 明确时区、错过执行语义、并发/重入、超时、锁、日志、重试和失败告警。
- 使用绝对路径和受控 `PATH`，不要依赖交互 shell profile 或当前目录。
- 不把 token、密码直接写入 cron 命令；使用受控 secret 机制。
- 为脚本设置最小用户、umask 和资源限制，处理重复运行和部分失败。
- 先手动在相同用户/环境下做非破坏性验证，再启用 timer。
- 停用旧任务与启用新任务分步，防止重复执行或调度空窗。

生产新增/修改计划任务至少为 R2；会删除数据、重启服务、批量变更或不可重入时为 R3。

## 7. 进程环境和 secret

- `/proc/<pid>/environ`、服务 EnvironmentFile 和命令行可能含 secret，默认不读取或展示全量。
- 只确认某变量是否存在或是否指向正确来源；值用长度、fingerprint 或脱敏形式报告。
- 发现 secret 出现在命令行、日志或世界可读文件时，先限制扩散，记录暴露范围，再由所有者轮换。
- 不通过 shell history 传入密码，不关闭 history 来隐藏未经授权操作。

## 8. 验证与回滚

身份变更后至少验证：

- 目标主体能做被授权的动作，不能做未授权动作。
- 现有管理员和服务账户未被锁死。
- 文件访问、sudo、SSH/PAM 日志无新错误。
- timer 下一次运行时间、实际用户、环境和输出符合预期。
- 原账户、组、ACL、key 或任务配置可按记录恢复。

权限“看起来正确”不是完成标准，应以目标用户的实际最小访问测试为准，避免用 root 测试掩盖权限问题。
