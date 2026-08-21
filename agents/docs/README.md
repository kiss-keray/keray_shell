# Linux 运维 Agent 专题文档索引

本目录补充 `../default.md` 的操作细节，用于避免核心提示词过大。`../default.md` 始终优先；本目录任何示例都不能替代授权、预检、回滚和验证。

## 读取规则

1. 先遵守 `../default.md`；标准 Skill 通过 `load_skill` 按名称加载，普通专题文档通过 `load_doc_body` 按相对 `agents/` 路径加载。
2. 多领域故障先读 `diagnosis-playbooks.md`，确认故障层后再读对应专题。
3. 任何 R2/R3 变更同时读 `safety-and-authorization.md` 与 `change-and-rollback.md`。
4. 怀疑安全事件时优先读 `incident-response.md`，不要先清理或重启。
5. 文档中的命令是模板，必须按实际发行版、服务、设备、文件系统和工具版本校验。

## 文档地图

| 文档                                                                                         | 适用任务                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`safety-and-authorization.md`](safety-and-authorization.md)                                 | 风险分级、授权有效性、sudo、敏感信息、命令构造和批量操作     |
| [`diagnosis-playbooks.md`](diagnosis-playbooks.md)                                           | 不明原因故障、CPU/内存/进程/systemd/日志/时间/TLS 的通用排障 |
| [`change-and-rollback.md`](change-and-rollback.md)                                           | 配置文件、systemd、包、sysctl、内核和重启变更                |
| [`storage-and-filesystem.md`](storage-and-filesystem.md)                                     | 空间、inode、IO、只读挂载、LVM、RAID、fsck 和清理            |
| [`network-and-remote-access.md`](network-and-remote-access.md)                               | 地址、路由、端口、DNS、防火墙、SSH 和远程访问                |
| [`accounts-permissions-and-scheduled-tasks.md`](accounts-permissions-and-scheduled-tasks.md) | 用户、组、sudo、ACL、SSH key、cron 和 systemd timer          |
| [`containers.md`](containers.md)                                                             | Docker/Podman/containerd 的资源、日志、网络、存储和清理      |
| [`backup-and-recovery.md`](backup-and-recovery.md)                                           | RPO/RTO、备份核验、快照、恢复计划和演练                      |
| [`incident-response.md`](incident-response.md)                                               | 入侵、恶意进程、凭据泄露、勒索和证据保全                     |

## 共同约定

- `[R0]`：低负载只读；`[R1]`：可能高负载或敏感；`[R2]`：可逆变更；`[R3]`：高影响；`[R4]`：禁止。
- 命令中的 `<...>` 是必须替换并核对的占位符，不能原样执行。
- 文档给出多个发行版命令时，只选择与目标系统一致的一组。
- 示例输出不是事实；结论只能来自当前目标的真实输出。
