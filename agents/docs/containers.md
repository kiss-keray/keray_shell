# 容器主机排障与安全操作

本文覆盖 Docker、Podman 和 containerd 的主机侧排障。不要假定 runtime；Kubernetes 控制面或集群对象变更只有在用户明确纳入范围时处理。

## 1. 先区分观察视角

明确当前命令运行在：

- 物理机/虚拟机宿主机。
- 容器内。
- 特定 network/mount/PID/user namespace。
- Kubernetes node、pod 或控制面客户端环境。

容器内看到的 CPU、内存、PID、磁盘和网络可能受 cgroup/namespace 限制，不能直接代表宿主机。

```bash
# [R0] 识别 cgroup、容器迹象与 runtime 服务。
cat /proc/1/cgroup
systemd-detect-virt --container 2>/dev/null
systemctl status docker podman containerd --no-pager 2>/dev/null
```

## 2. 只读盘点

选择实际 runtime 的命令，不要三套全部执行：

```bash
# [R0/R1] 列表和 inspect 可能暴露镜像、挂载、环境变量名称和网络元数据。
docker ps --no-trunc
docker stats --no-stream
docker inspect <container>
docker system df
```

```bash
# [R0/R1] Podman 对应检查。
podman ps --no-trunc
podman stats --no-stream
podman inspect <container>
podman system df
```

containerd/CRI 环境先确认既定客户端和 namespace；不要随意混用 `ctr`、`nerdctl`、`crictl`，它们展示和管理的对象可能不同。

## 3. 容器反复退出或启动失败

按顺序检查：

1. 容器状态、退出码、OOMKilled、启动/结束时间和 restart count。
2. 限定时间和行数的 stdout/stderr。
3. entrypoint/command、用户、工作目录、挂载、端口和健康检查。
4. 宿主机 runtime 与内核日志。
5. 依赖、secret/config、镜像架构和文件权限。

```bash
# [R0] 输出可能含业务数据，限制时间并脱敏。
docker inspect <container> --format '{{json .State}}'
docker logs --since <duration> --tail <lines> <container>
journalctl -u docker -u containerd --since '<start-time>' --no-pager
journalctl -k -b --no-pager | grep -Ei 'oom|cgroup|overlay|veth|nf_conntrack'
```

不要用无限 restart 掩盖错误；反复重启可能放大流量、损坏状态或触发依赖限流。

## 4. 资源与 cgroup

```bash
# [R0]
docker stats --no-stream <container>
docker inspect <container> --format '{{json .HostConfig}}'
cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null
```

判读：

- 容器 OOM 可能由 cgroup limit 触发，宿主机仍有 available memory。
- CPU 百分比受配额和显示口径影响；同时看 throttling、宿主负载和业务延迟。
- 容器 writable layer 增长可能来自日志、缓存或应用写错路径。
- 调高 limit 是 R2，可能把压力转移到宿主或其他容器；先找到使用增长原因。

## 5. 日志边界

- 确认 log driver、轮转、最大大小和日志实际落点。
- 不直接 truncate runtime 管理的日志文件；可能破坏读取状态或只短暂释放空间。
- 不删除容器目录下未知 JSON、metadata 或 overlay 文件。
- 容器日志可能含 token/请求体，查询时限制时间、行数和分享范围。
- 修改 log driver/rotation 通常只对新建容器或重建后生效，应评估中断。

## 6. 网络

先确认端口发布、容器 IP、network、DNS 和宿主监听：

```bash
# [R0]
docker port <container>
docker inspect <container> --format '{{json .NetworkSettings.Networks}}'
docker network ls
ss -lntup
```

安全边界：

- 不直接 flush/编辑 Docker/Podman 生成的 iptables/nftables 链。
- 不删除 veth、bridge 或 network 来测试。
- `docker exec` 内检查与宿主检查分开记录，明确命名空间。
- 修改端口发布通常需要重建容器，按 R2/R3 并准备流量切换。

## 7. 存储、volume 与 overlay

```bash
# [R0/R1]
docker inspect <container> --format '{{json .Mounts}}'
docker volume ls
docker system df -v
findmnt -T <runtime-data-root>
```

绝对边界：

- 不直接删除 `/var/lib/docker`、`/var/lib/containerd`、`/var/lib/containers` 下的文件。
- 不用 `docker system prune -a --volumes`、`podman system prune --all --volumes` 作为常规清理。
- anonymous volume、stopped container 和未被当前 runtime 列出的目录仍可能有业务数据。
- volume 删除、迁移、恢复和文件系统修复按 R3；先映射到容器、应用和备份。
- overlay `du` 容易重复计数；结合 runtime 报告、文件系统和实际 mount 分析。

安全清理必须先生成候选清单，逐个确认镜像/容器/volume 的引用、最后使用时间、重建来源和数据价值，再获得精确授权。

## 8. 镜像与供应链

- 使用不可变 digest 确认实际镜像，不只依赖可变 tag。
- 不拉取或运行来源不明、未签名/未扫描的镜像。
- 不在生产直接使用 `latest` 验证修复。
- 更新前记录旧 digest、配置、挂载、secret 引用、健康检查和回滚镜像可用性。
- 不在输出中展示 registry credential、镜像构建 secret 或完整环境变量。

镜像 pull 是写入和网络动作 `[R2]`；替换运行中容器可能中断，按 `[R3]` 并先 canary。

## 9. exec、restart、stop 与重建

- `exec` 进入容器不等于可以任意修改镜像内文件；临时修改不可追溯且重建会丢失。
- 优先修改声明式配置/镜像来源，不做“雪花容器”长期修复。
- restart/stop/kill 为 R3；先确认副本、连接 draining、持久化写入和 restart policy。
- 重建前导出当前声明式参数或确认 Compose/systemd/Kubernetes 等权威来源，不靠手抄 `docker inspect` 猜测。
- 回滚需验证旧镜像、schema 和 volume 数据是否兼容。

## 10. Kubernetes 边界

若主机受 Kubernetes 管理：

- 不直接重启 kubelet、删除 pod sandbox、改 CNI 规则或清理 `/var/lib/kubelet`。
- drain/cordon、删除 pod、修改 workload、节点重启和控制面操作属于独立 R3，需集群授权、PDB/quorum/容量评估。
- 容器 runtime 看到的对象与 Kubernetes 期望状态可能不同；先查控制器事件和节点 condition。
- 静态 pod、DaemonSet、local PV 和单副本工作负载需要额外保护。

## 11. 完成标准

容器问题修复后同时验证：

- runtime/container 状态和 restart count 稳定。
- 健康检查、端口、DNS、依赖和真实业务请求正常。
- cgroup 资源、宿主资源、日志和存储增长正常。
- 声明式配置与运行状态一致，重建后不会丢失修复。
- 旧镜像/配置回滚路径仍可用，未遗留敏感临时文件或调试容器。
