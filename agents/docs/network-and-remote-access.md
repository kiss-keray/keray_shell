# 网络、DNS、防火墙与远程访问

网络问题按“本机进程 → socket → 地址/路由 → 邻居/链路 → 防火墙/策略 → DNS/TLS → 对端”分层。修改网络、SSH 或防火墙可能使唯一远程连接永久中断，默认按 R3。

## 1. 先定义失败路径

明确：

- 源主机/namespace、目的 IP/域名/端口、协议和地址族。
- 是连接超时、拒绝、reset、DNS 失败、TLS 失败还是应用状态码。
- 所有客户端失败还是单来源失败，何时开始，最近有什么变更。
- 流量是否经过代理、LB、NAT、VPN、容器、service mesh 或安全设备。

不要把 `ping` 成功等同于 TCP/UDP/应用成功；ICMP 失败也不证明主机不可达。

## 2. 本机身份、地址和路由

```bash
# [R0]
ip -br link
ip -br address
ip rule show
ip route show table all
ip -6 route show table all
ip route get <destination-ip>
```

判读：

- `ip route get` 比只看 default route 更能反映策略路由后的实际出口和源地址。
- 多网卡、VRF、network namespace 和容器会有不同路由视图。
- 地址存在不代表 DAD、邻居、VLAN、MTU 和上游路由正常。
- 不主动执行会发包或改变状态的 `arping`、大范围扫描和 flood ping；必要时按 R1 限定目标和次数。

## 3. 端口与进程

```bash
# [R0]
ss -lntup
ss -s
systemctl status <service> --no-pager -l
```

确认监听地址是 `127.0.0.1`、具体地址、`0.0.0.0` 还是 `[::]`，以及 IPv4/IPv6 双栈语义。端口被监听只证明 socket 存在，还需检查本地请求和业务健康。

连接状态较多时先按端口过滤，避免全量 `ss -antp` 泄露不相关对端信息。

## 4. 分层连通性

```bash
# [R0/R1] 这些命令会主动连接指定目标；仅对已授权目标使用并设置超时。
ping -c 3 -W 2 <destination-ip>
timeout 10 nc -vz <destination-host> <port>
curl --connect-timeout 5 --max-time 15 -v <scheme>://<host>:<port>/<health-path>
tracepath <destination-ip>
```

- HTTP 检查不要携带真实 token，除非任务确需且使用受控注入方式；输出需脱敏。
- `curl -k` 只能用于隔离“证书验证失败”这一假设，不能作为永久配置或修复建议。
- traceroute/tracepath 中间 hop 不响应很常见，不能单凭星号判定该 hop 故障。
- UDP 没有 TCP 握手语义，`nc` 结果需结合服务日志和抓包。

## 5. DNS

```bash
# [R0/R1] 查询会访问配置的 DNS 服务器。
cat /etc/resolv.conf
resolvectl status 2>/dev/null
getent ahosts <name>
dig <name> A
dig <name> AAAA
dig +trace <name>
```

`dig +trace` 会直接查询外部权威链，可能绕开企业 split DNS，按 R1 且仅在适用时使用。

排查要区分：

- libc/NSS 解析与直接 DNS 查询。
- search domain、`ndots`、缓存、systemd-resolved stub 和容器 DNS。
- NXDOMAIN、SERVFAIL、timeout、错误地址、IPv6 优先和 TTL/缓存未过期。
- TLS SNI/证书名与 DNS 解析是不同层。

不要直接覆盖 `/etc/resolv.conf`；它可能由 NetworkManager、systemd-resolved、DHCP 或配置管理生成。

## 6. 防火墙和策略

先识别实际管理者，避免同时修改多套规则：

```bash
# [R0] 仅列出；可能需要 sudo 才完整。
nft list ruleset 2>/dev/null
iptables-save 2>/dev/null
firewall-cmd --state 2>/dev/null
firewall-cmd --list-all 2>/dev/null
ufw status verbose 2>/dev/null
```

还要考虑 cloud security group、ACL、宿主机与容器链、SELinux port label、代理/LB 和上游设备。

绝对边界：

- 不 flush 整套规则，不关闭防火墙来测试。
- 不用永久 allow-all 或 `0.0.0.0/0` 替代精确来源。
- 不直接编辑 runtime 生成的 Docker/Kubernetes 链。
- 不在同一步同时改 firewall 与 SSH 配置。

安全变更顺序 `[R3]`：

1. 导出并保护当前规则，确认管理工具和持久化来源。
2. 准备独立的带时限回滚；先验证回滚机制实际可运行。
3. 保持当前 SSH 会话，添加比旧规则更精确的新规则。
4. 从第二会话/真实来源验证新连接与业务流量。
5. 观察日志和计数器，再决定是否删除旧规则。
6. 保存持久化配置并验证重载/重启后的预期，但不要为验证而贸然重启生产主机。

## 7. SSH 安全排障

只读检查：

```bash
# [R0]
sshd -T 2>/dev/null | grep -Ei '^(port|listenaddress|permitrootlogin|passwordauthentication|pubkeyauthentication|allowusers|allowgroups|maxauthtries) '
sshd -t 2>/dev/null
journalctl -u sshd -u ssh --since '<start-time>' --no-pager -o short-iso
```

客户端诊断可用 `ssh -vvv`，但输出可能包含用户名、主机、key 路径和认证细节，分享前脱敏。

修改前必须：

- 确认发行版的 unit 名和实际加载的 `sshd_config`/include。
- 保留当前会话，确保有第二个管理员会话或控制台。
- 用 `sshd -t` 验证，优先 reload，并验证新会话后再关闭旧会话。
- 为端口/认证策略变化准备自动回滚。

不得：

- 通过 `StrictHostKeyChecking=no` 或删除 known_hosts 条目来掩盖未核实的 host key 变化。
- 启用 root 密码登录、空密码或弱算法作为常规修复。
- 把私钥内容、密码或完整认证日志贴入聊天。

## 8. TLS

```bash
# [R0/R1] 主动连接已授权目标，明确 SNI。
timeout 10 openssl s_client -connect <host>:<port> -servername <dns-name> -showcerts </dev/null
```

检查：证书链、SAN、有效期、系统时间、SNI、信任库和服务实际加载的证书。不要因为文件已更新就认定进程加载了新证书；需结合服务能力安全 reload 并再次从客户端验证。

私钥权限或匹配检查不要输出私钥。只比较由公钥派生的摘要，并将生成物放在受限环境。

## 9. 抓包边界

抓包按 `[R1]`，因为可能包含凭据和业务数据：

- 限定接口、host、port、方向、包数或时长。
- 使用 `umask 077`，文件放在受限且空间充足的目录。
- 先评估磁盘和 CPU；禁止无边界后台抓包。
- 只展示解决问题所需的字段，传输和保存遵循数据策略。
- TLS 加密不代表元数据不敏感。

示例：

```bash
# [R1] <interface>/<host>/<port>/<count>/<capture-file> 必须明确。
sudo tcpdump -i <interface> -nn host <host> and port <port> -c <count> -w <capture-file>
```

## 10. 网络 namespace 与容器

- 宿主机、容器和 pod 可能有不同的接口、DNS、路由和防火墙视图。
- 先确认进程所在 netns/cgroup，再选择执行位置。
- 不直接删除 veth、bridge、namespace 或 runtime 生成规则。
- 容器问题转 `containers.md`；避免只在宿主机上看到端口就忽略容器健康。

## 11. 停止条件

- 当前操作可能断开唯一远程连接，且无控制台/回滚。
- 不清楚是 NetworkManager、systemd-networkd、ifupdown、netplan 还是外部配置管理负责。
- 防火墙规则同时由多个系统维护，或当前导出不完整。
- host key 意外变化、发现未知监听/隧道或疑似流量劫持。
- 需要更改生产路由、默认网关、DNS、VPN、SSH/PAM 或大范围 allow 规则。

停止后报告失败层、源/目的五元组、关键证据、当前会话风险和所需网络/安全负责人。
