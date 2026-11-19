# 刷机文件（京东云亚瑟 AX1800 Pro / RE-SS-01）

把本固件刷进设备需要的 U-Boot 和 GPT 分区表都放在这个目录里，原发布地址失效也能用。固件本身（`factory.bin` / `sysupgrade.bin`）在本仓库的 [Releases](https://github.com/xuxh-linux/-istoreos-re-ss-01/releases)。

下载前后可以用 [`SHA256SUMS`](SHA256SUMS) 校验：

```sh
cd flash && sha256sum -c SHA256SUMS
```

## 文件清单

| 文件 | 用途 | 来源 / 原地址 | SHA256 |
| --- | --- | --- | --- |
| [`uboot/uboot-ipq60xx-jdcloud_re-ss-01-260816_142236_3011049.bin`](uboot/uboot-ipq60xx-jdcloud_re-ss-01-260816_142236_3011049.bin) | U-Boot（路线 A，推荐） | [chenxin527/uboot-qsdk12.5-build 发布页 26.08.16-14.22.36-3011049](https://github.com/chenxin527/uboot-qsdk12.5-build/releases/tag/26.08.16-14.22.36-3011049)，GPL-2.0 | `483d1a998d48e3c32f78255908bf21e76d3bf5c580c3eb95cf550996a46c231f` |
| [`uboot/u-boot-12m.bin`](uboot/u-boot-12m.bin) | U-Boot（路线 B，带 `/big.html`） | 原发布仓库 GHNERCH/DAEWRT-AX1800PRO 已删除；取自其分叉 [yxs123321/DAEWRT-AX1800PRO](https://github.com/yxs123321/DAEWRT-AX1800PRO/blob/main/u-boot-12m.bin)（提交 `54111be0c6`，2025-12-08） | `1d4d964b695e4ed47e0dc780c8912ae5ea412ab684185472c1326f3f861a3736` |
| [`gpt/gpt-JDC_AX1800_Pro_dual-boot_rootfs2048M_HLOS12M_no-last-partition.bin`](gpt/gpt-JDC_AX1800_Pro_dual-boot_rootfs2048M_HLOS12M_no-last-partition.bin) | GPT 分区表：rootfs 2048 MiB、HLOS 12 MiB，双分区 | 原地址 `https://github.com/GHNERCH/DAEWRT-AX1800PRO/raw/main/gpt-…bin` 已 404；取自分叉 [j55455/DAEWRT-AX1800PRO](https://github.com/j55455/DAEWRT-AX1800PRO)，与 [yxs123321/DAEWRT-AX1800PRO](https://github.com/yxs123321/DAEWRT-AX1800PRO) 中的同名文件逐字节相同（同一提交 `54111be0c6`） | `21a4e12f1bfc3e17cf65b0ce3817ef59176031aaaedafc1354c9715fd44b5b97` |

### 核对情况

- **GPT**：和一台按本流程刷机、正常运行本固件的设备核对过，26 个分区的起止扇区全部一致。设备上还会多一个占满剩余空间的大分区，是系统首次启动时自动建的，文件名里的 `no-last-partition` 指的就是它。不带这个分区，任何 4 GB 以上的 eMMC 都能用这张表。
- **两个 U-Boot**：只核对了文件和原发布地址的一致性（SHA256），以及各自网页里有哪些刷机页面（从二进制里读出的页面列表）。这台核对用的设备运行的是第三个 U-Boot（2024-05-05 编译，网页只有 `/uboot.html` 一个刷写页），这两个都没在它上面实际刷过。

## 刷机步骤

先在电脑上把网卡设成 `192.168.1.2/24` 之类的静态地址，网线接路由器 LAN 口。**进 U-Boot 网页**：按住 Reset 键给路由器通电，LED 闪烁后松开，浏览器打开 `http://192.168.1.1`。

1. **刷 U-Boot**（只需一次）。在当前 U-Boot 的 `http://192.168.1.1/uboot.html` 上传下面任选的一个 U-Boot，刷完重启再进一次 U-Boot 网页。
2. **刷 GPT 分区表**（只需一次，不能省略）：上传 `gpt/` 里的文件，路线 A 用网页的「分区表」页（`/ptable.html`），路线 B 用 `/img.html`。这一步会改掉原分区布局，刷之前备份好原厂分区，尤其是 ART（无线校准数据和 MAC 地址，丢了没法恢复）。
3. **刷固件**：从 Releases 下载完整版或纯净版的 `factory.bin`，按所用 U-Boot 选页面：
   - **路线 A（chenxin527 U-Boot）**：在网页的「固件」页刷 `factory.bin`。按其说明，OpenWrt factory 镜像只要内核按 2 MiB 的整数倍填充就能自动识别，本固件是 12 MiB。这个 U-Boot 也能直接刷 `sysupgrade.bin`。分区表在它的「分区表」页刷。
   - **路线 B（u-boot-12m.bin）**：在 **`http://192.168.1.1/big.html`** 刷 `factory.bin`，**不要用默认首页**。HLOS12M 分区的内核按 12M 填充，只有 `/big.html` 按这个大小写入，用首页刷完会卡红灯、没有 IP。这条路线是本固件原作者实测过的（见仓库提交 `0129239fbb`、`873f269ce2`）。
4. 首次启动后后台地址是 **`http://10.0.0.1`**。以后在系统里用 `sysupgrade.bin` 升级，完整版和纯净版可以互刷，换版本时建议不保留配置。

## 其他参考

- 1 GB 内存硬改需要先刷对应内存颗粒的 CDT，CDT 和颗粒型号绑定，本目录不提供。
- 刷坏后用 9008 模式救砖的工具和教程：[lelehub/JDCloud-AX1800-Pro](https://github.com/lelehub/JDCloud-AX1800-Pro)（`京东云AX1800-Pro亚瑟_AX6600雅典娜USB救砖` 目录）。
- 原 GHNERCH 仓库 README 里给出的分区表和 U-Boot 更换教程：<https://www.right.com.cn/forum/thread-8402269-1-1.html>
- chenxin527 U-Boot 的完整说明（进网页的其他方法、支持的固件格式）：[uboot-qsdk12.5-build](https://github.com/chenxin527/uboot-qsdk12.5-build)

刷机有风险，请自行评估。
