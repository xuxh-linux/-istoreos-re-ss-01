# iStoreOS for 京东云亚瑟 AX1800 Pro（RE-SS-01）

基于 [iStoreOS](https://github.com/istoreos) `25.12` 分支，适配 **京东云亚瑟 AX1800 Pro（内部型号 RE-SS-01，IPQ6000，eMMC）** 的独立构建仓库，通过 GitHub Actions 自动编译固件。

## 支持设备

| 项目 | 说明 |
| --- | --- |
| 设备名 | 京东云亚瑟 AX1800 Pro |
| 内部型号 | JDCloud RE-SS-01 |
| SoC | Qualcomm IPQ6000（四核 Cortex-A53） |
| 内存 | 512 MB / 1024MB |
| 存储 | eMMC（无 NAND） |
| OpenWrt 标识 | `jdcloud_re-ss-01` |
| 目标子架构 | `qualcommax / ipq60xx` |

## 两个版本

每次构建同时出两个版本，各自发一个 Release（tag 以 `-full` / `-pure` 结尾）：

| 版本 | 预装内容 | 适合 |
| --- | --- | --- |
| 完整版 `full` | 下面「内置软件」里的全部：代理插件、4G、Samba / NFS / DLNA、adblock、usteer 等 | 刷机即用 |
| 纯净版 `pure` | 只有 iStoreOS 首页 / 网络向导 / 应用商店、基础 LuCI、中文、终端、devmon（设备管理、流量监控、抓包） | 想自己从 iStore 挑应用 |

纯净版说明：

- 本固件的内核是自编的，软件源里的内核模块装不上（内核哈希对不上），所以纯净版仍把 Docker、透明代理（tproxy / socket / TUN）、WireGuard、SQM / eqos、常见文件系统和 USB 有线网卡要用的内核模块编进固件，从 iStore 装 Docker、PassWall、zerotier 这类应用不受影响；
- 不带 daed 用的 BTF 调试信息，镜像比完整版小得多；4G 模块驱动也不带；
- 卡死诊断、zram、中断分核、默认设置和完整版相同（usteer 不在纯净版里）。

两个版本的包清单在 [`.github/configs/`](.github/configs/)，本地编译：

```sh
cp .github/configs/re-ss-01-pure.seed .config   # 完整版换成 re-ss-01-full.seed
make defconfig && make -j$(nproc)
```

## 内置软件（完整版）

- **设备管理 / 抓包**：luci-app-devmon（自研，设备列表、流量监控、tcpdump 抓包），两个版本都有；
- **代理插件（预装，默认全部关闭，同一时间只开一个）**：大鹅 daed + luci-app-daede、PassWall（Xray 26.7.28）、HomeProxy、mosdns；
- **eBPF / BTF 内核支持**：已开启 BTF、XDP、BPF Events、CGROUPS，并内置 daed 所需内核模块（kmod-sched-core / kmod-sched-bpf / kmod-veth / kmod-xdp-sockets-diag）；
- **TUN/TAP 虚拟网卡（kmod-tun）**：TUN 模式代理可直接使用；
- **无线**：完整版 wpad（802.11k/v）+ usteer 双频引导，relayd + luci-proto-relay 中继桥接；
- **zram-swap**：默认开启压缩交换（zstd），降低小内存机型 OOM 概率；
- **中断分核**：WiFi / 有线网卡中断开机自动分散到 4 个核心，避免全部压在 CPU0；
- **卡死诊断**：开启软 / 硬锁死和 hung task 检测，内核锁死时自动 panic 重启，不用再拔电；ramoops 保留重启前的内核日志，重启后在 `/sys/fs/pstore` 查看（断电会清空）。

## 默认设置

| 项目 | 默认值 |
| --- | --- |
| 后台地址 | `http://10.0.0.1`（LAN DHCP 已开启） |
| WiFi | `404 Not Found`（2.4G/5G 同名，usteer 自动选频段），密码 `12345678`，首次启动自动开启；5G 默认 149 信道（国内 36 信道限 23 dBm，149 可到本机上限 27 dBm） |
| 默认关闭的服务 | 软件流量卸载（会绕过 dae 的 eBPF）、mwan3（单 WAN 无意义）、frpc、haproxy、tailscale |
| 广告过滤 | adblock 走 dnsmasq，规则源 anti_ad（约 10 万条），WAN 上线后自动拉取 |
| watchcat | 6 小时 ping 不通 `223.5.5.5`、`119.29.29.29` 才重启 |

刷机后请立即修改 root 密码和 WiFi 密码。

## 刷机流程

刷机要用的 U-Boot、GPT 分区表，以及每个文件的来源、原地址、SHA256 都整理在 [`flash/`](flash/) 目录，详细步骤见 [flash/README.md](flash/README.md)。简要流程：

1. 换 12M 大分区 U-Boot：旧 U-Boot 的刷写页是 `http://192.168.1.1/uboot.html`；
2. 刷 2GB GPT 分区表（rootfs 2048 MiB / HLOS 12 MiB，不能省略）；
3. 在 U-Boot 网页刷本项目 Releases 里的 `factory.bin`。用 chenxin527 U-Boot 时走它的「固件」页；用 `u-boot-12m.bin` 时必须走 `http://192.168.1.1/big.html`，用默认首页刷会卡红灯；
4. 首次启动后台地址 `http://10.0.0.1`，以后用 `sysupgrade.bin` 升级。

### U-Boot 版本说明

<!-- UBOOT-NOTES-START -->
**当前版本**：`26.08.16-14.22.36-3011049` ｜ **发布日期**：2026-08-16 ｜ [作者发布页](https://github.com/chenxin527/uboot-qsdk12.5-build/releases/tag/26.08.16-14.22.36-3011049)

**更新内容**

- **新特性**
  - U-Boot 启动时打印设备信息（设备型号和 config_name）。
  - 支持刷写纯 NOR 固件（分区表参考高通 [meta-tools](https://github.com/chenxin527/meta-tools) 中的 nor-partition.xml），暂不支持刷写单 firmware 分区的纯 NOR 固件。
- **BUG 修复**
  - 修复网络命令 (ping, tftpboot, tftpput 等) 在网页终端/Telnet 终端下执行后 httpd 可能失联的问题。
  - 修复网页终端下部分命令执行时间过长导致 TCP 连接超时的问题。
  - 修复 JDCloud BE6500 的 factory 固件解析失败的问题（将 factory 固件 kernel 大小限制调整为 1 MiB 的整数倍）。
  - 修复 CMIOT AX18、Qihoo 360V6、Redmi AX5 JDCloud 和 ZN M2 部分网口不通的问题。
- **优化**
  - 只在 BOOTCONFIG 分区数据有效时执行 bootconfig 命令，避免用户主动擦除了 BOOTCONFIG 分区的情况下执行该命令导致固件刷写结果返回失败。
  - 优化 9008 模式下的 MIBIB 自动重载逻辑。
  - 优化 tftp/wget 文件传输进度、传输速率及文件大小信息显示。
  - IPQ53xx/IPQ95xx: 防止长时间无网络活动导致 PPE 硬件休眠。
  - wget/flashread: 当用户未指定加载地址且 loadaddr 环境变量未设置时，根据设备内存大小自动设置默认加载地址。
  - autoboot: 若 bootcmd 不是 bootipq 且其运行失败，则自动尝试运行 bootipq。
- **其他**
  - 默认开启 httpd_debug 模式，打印详细的日志信息，便于调试。
  - 调整 CMIOT AX18、Redmi AX5 JDCloud 和 ZN M2 的 LED 配置。
  - 精简部分机型包含的额外 DTB，减小 U-Boot 大小。
<!-- UBOOT-NOTES-END -->

## 大鹅 daed 配置要点

daed 已预装，在 `服务` 菜单或 `http://10.0.0.1:2023` 打开面板，首次进入先创建账号，然后导入订阅、新建分组（把订阅加进去）、点右上角运行。以下几项不按此设置会出问题：

1. **全局配置 → LAN 接口选 `br-lan`**（有线和 WiFi 都桥接在里面；只选 lan1~lan3 时 WiFi 设备不走代理）。
2. **全局配置 → 拨号模式选 `domain+`**。默认的 `domain` 只对经 dae 解析的 IP 改用域名拨号，路由器本机等 DNS 不经过 dae 的流量会拿被污染的 IP 去拨号，表现为 TLS 握手中途断开。
3. **DNS 配置**：把 `.lan` 交给本机 dnsmasq（否则局域网主机名无法解析），并用 geosite 拦截广告（dae 接管 DNS 后 adblock 不再生效）：

```
dns {
upstream {
  alidns: 'udp://223.5.5.5:53'
  googledns: 'tcp+udp://8.8.8.8:53'
  local: 'udp://127.0.0.1:53'
}
routing {
  request {
    qname(suffix: lan) -> local
    qname(geosite:category-ads-all) -> reject
    qname(geosite:cn) -> alidns
    fallback: googledns
  }
}
}
```

4. **路由规则**可用默认模板：

```
pname(NetworkManager, systemd-resolved, dnsmasq) -> must_direct
dip(geoip:private) -> direct
dip(geoip:cn) -> direct
domain(geosite:cn) -> direct
fallback: proxy
```

切换到 PassWall 前先在面板里停止 daed；两者同时运行会争抢防火墙和 DNS。512M 内存的设备节点不要搞太多，搞太多爆内存，路由器会死掉。

## 其他翻墙插件

固件已预装大鹅、PassWall、HomeProxy、mosdns，一般无需另装。其他插件（OpenClash、Nikki 等）下载地址：[Are-u-ok iStoreOS_25.12 发布页](https://github.com/bcseputetto/Are-u-ok/releases/tag/iStoreOS_25.12)（AX1800 Pro 为 aarch64_a53 架构，请下载对应版本）。

## 无线

首次启动自动开启，双频同名 `404 Not Found`。usteer 依赖 802.11k/v 引导终端选择频段，可在 `网络 → usteer` 查看。

做 WiFi 中继时，同一频段的 AP 会被强制切到上级 WiFi 的信道，中继断开时该频段 AP 也会短暂掉线；建议用 5G 连接上级，2.4G 保持覆盖。

## 感谢

iStoreOS：[仓库链接](https://github.com/istoreos/)

## 免责声明

刷机有风险，请自行评估；本仓库仅用于学习交流。

## 许可证

基于 iStoreOS / OpenWrt，遵循 **GPL-2.0**。
