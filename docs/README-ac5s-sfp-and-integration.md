# BeeconMini SEED AC5S × immortalwrt (kernel 6.18) 集成层

基于 `/home/lwj/immortalwrt`（immortalwrt master，mediatek 目标，`KERNEL_PATCHVER:=6.18`）
的 AC5S 驱动/设备集成。**不修改任何现有源文件**：新增文件在 `newfiles/`，对现有
文件的改动全部以补丁形式放在 `patches/`。

## 背景与动机

BeeconMini 官方 rtl8373n 驱动是**闭源二进制**（`realtek,rtl8373n` + `mediatek,mdio`
专属绑定），官方只提供 6.12.94 / 6.12.95 的预编译 `.ko`（vermagic 写死，6.18 无法加载）。
因此本集成改用**社区开源驱动** `rtl837x-gsw`（RuijieNetworksCommunity/rtl837x-gsw-driver，
与官方二进制同源——都是 Realtek SDK 的 `dal/rtl8373` 代码，函数名一一对应），
固定提交 `a1650c6`（2026-05-25，已内置 `fix build with linux 6.18.x`）。

## 目录结构

```
immortalwrt-ac5s-overlay/
├── apply.sh                 # 一键应用脚本
├── newfiles/                # 全新文件（直接复制进源码树）
│   ├── package/kernel/rtl837x-gsw/
│   │   ├── Makefile                                            # switch-rtl837x 内核包（git 拉取，pin a1650c6）
│   │   └── patches/0001-rtl837x-make-sfp-probe-optional.patch  # 驱动补丁：无 sfp 属性时跳过 SFP bus 探测
│   └── target/linux/mediatek/dts/
│       ├── mt7987a-beeconmini-seed-ac5s.dts     # eMMC/SD 变体
│       └── mt7987a-beeconmini-seed-ac5s-nor.dts # NOR 变体
└── patches/
    ├── 100-filogic-mk-add-beeconmini-seed-ac5s.patch        # image/filogic.mk 设备定义
    └── 110-filogic-02_network-add-beeconmini-seed-ac5s.patch # 网络/接口/MAC 定义
```

## 硬件信息（来自 BeeconMini 官方 DTS 与官网）

- **SoC**: MediaTek MT7987A（filogic，Cortex-A53）；**交换芯片**: RTL8373N
  （8×2.5G 电口 + 10G SFP+，官网规格）
- WAN 2.5G：EN8811H PHY（gmac0，`ethernet-phy-id03a2.a411`，主线 v6.18 已有驱动）
- 交换芯片上行：gmac1（internal PHY phy15）→ 社区驱动 `ethernet = <&gmac1>`
- 外围：RTL8238B（i2c0@0x20）、SPI-NOR（BL2/uboot-env/art/FIP）、eMMC/SD（mmc0）、
  PCIe（M.2/NVMe）、USB3、SFP 供电 GPIO（pio11）、风扇 GPIO（pio10）
- 网络布局（官方 02_network）：LAN=eth1（交换芯片），WAN=eth0（EN8811H）；
  MAC 从 `art` 分区 0x0 读取

## 应用方法

```bash
# 1. 应用集成层（默认目标 /home/lwj/immortalwrt）
/home/lwj/immortalwrt-ac5s-overlay/apply.sh

# 2. 构建
cd /home/lwj/immortalwrt
./scripts/feeds update -a && ./scripts/feeds install -a
make menuconfig    # Target: MediaTek → Filogic；Device 里勾选 BeeconMini SEED AC5S
make -j$(nproc)    # 产物: bin/targets/mediatek/filogic/
```

设备名：`beeconmini_seed-ac5s`（eMMC/SD）、`beeconmini_seed-ac5s-nor`（NOR）。
依赖包：`kmod-switch-rtl837x`、`kmod-phy-airoha-en8811h`、`airoha-en8811h-firmware`、
`mt7987-2p5g-phy-firmware`、`kmod-swconfig`（自动带上）。

## ✅ 硬件值（2026-08-14 实机确认，官方固件 25.12.3 @ 192.168.10.140）

| 项目 | 值 | 确认方法 |
|---|---|---|
| 交换芯片 MDIO 地址 | `reg = <29>` (0x1d) | 闭源驱动 `rtl8373_smi_read` 反汇编硬编码 0x1d；邮箱协议读回 chip ID `0x83737000`（=RTL8373N）。总线扫描仅 0x1d 响应邮箱窗口（reg 0x15-0x18），标准 PHY 寄存器不响应 |
| `rtl837x,cpu-port` | `<7>` | 官方 dmesg `<rtl8373> port:7 link UP - 2.5Gbps`；上行 gmac1→phy15（内部 2.5G 铜 PHY）→交换芯片电口 7；且 SDS0/1 均配置为 10G 模式（非上行）。CPU 口非 serdes 口，驱动会跳过 serdes 复位逻辑 |
| `rtl837x,sds0mode` | `"10g-qxg"` | 运行态 SDS 模式寄存器 0x7B20 = 0x0b4d：SDS0 mode=0xD（10GUSXG）+ sub-mode 2 — 与开放驱动 `"10g-qxg"` 写入的字节完全一致（SDS0 接 RTL8224N 10G PHY → SFP+ 笼） |
| `rtl837x,sds1mode` | `"10g-kr"` | 运行态 0x7B20：SDS1 mode=0x1A（10GR） |
| `reset-gpios` 极性 | `pio 8 GPIO_ACTIVE_HIGH` | 官方 DTS `mediatek,reset-pin = <&pio 8 0>`；运行态 debugfs `gpio-520 mediatek,reset-pin out hi`（高=运行） |
| 中断 | 未使用 | 社区驱动不请求中断（work queue 轮询），已省略 |

总线 0x13 存在一个未用响应者（r2=0x1a75，非邮箱设备），官方固件从不访问，与本集成无关。
侦查档案：`recon-2026-08-14/`（官方 DTB→DTS、bm-gsw.ko/rtl8373n.ko、mdio 扫描脚本等）。

**验证方法**：刷入 initramfs（`openwrt-mediatek-filogic-beeconmini_seed-ac5s-initramfs-kernel.bin`）
后 `dmesg | grep rtl837x` 应看到 `rtl837x dev info:smi-addr:29 cpu_port:7 serdes-mode:...`，
`swconfig list` 应出现 `switch0`。

## 与官方固件的差异（已知）

1. **VLAN 需通过 swconfig 配置**：社区驱动是 swconfig 框架。默认无配置时执行
   `rtk_vlan_reset()`（全端口通 CPU 的哑交换模式，可开箱即用）；需要 VLAN 时：
   ```sh
   swconfig dev switch0 vlan 1 set ports "0 1 2 3 4 5 6 7 8t"
   swconfig dev switch0 set enable_vlan 1
   swconfig dev switch0 set apply
   ```
2. **10G SFP+**：✅ **实机验证可用**（2026-08-14 插入 10G 光模块，官方固件 dmesg：
   `<rtl8373> port:8 link: UP - 10Gbps/FULL`）。当前实现=**供电（sfp_power）+ SDS0 10G serdes 固定模式**
   （`sds0mode="10g-qxg"` → RTL8224N），插入 10G 模块链路自动 UP。
   **无热插拔检测 / EEPROM 读取 / LOS 管理**（与官方固件同等水平）。

   2026-08-14 侦查确认的硬件事实：
   - SFP EEPROM (0x50) **不在 SoC I2C 总线上**（实机扫描 i2c-0 0x30–0x77 无响应）；
     交换芯片内部 I2C 主控寄存器实测 `DEV_ADDR=0x50`（0x418=0x00100280），但扫描全部
     SCL/SDA 引脚组组合（0-5）均无法读到 EEPROM → SFP EEPROM 实际挂在 RTL8224N
     （10G PHY）侧，社区驱动/官方固件均无 8224N 的 SFP EEPROM 透传代码。
   - 社区驱动 `rtl837x-gsw` 自带标准 Linux SFP 框架支持（`sfp = <&sfpX>` + `sff,sfp` 节点），
     但需要内核 i2c adapter + mod-def0 GPIO，且 SFP serdes 逻辑硬编码 SDS1（AC5S 在 SDS0）
     → **完整 SFP 管理在现有硬件/驱动下不可实现**，保持固定 10G 模式即可用。
   - **SFP+ 速率切换**（2026-08-14 实机确认，与官方功能对等）：驱动 swconfig 内置
     `serdes0_force_mode` + `serdes_reset`，SFP+（SDS0）支持 10G/2.5G/1G/100M：
     ```sh
     # 2.5G
     swconfig dev switch0 set serdes0_force_mode 22   # SERDES_2500BASEX
     swconfig dev switch0 set serdes_reset 0
     # 10G（默认）
     swconfig dev switch0 set serdes0_force_mode 0    # SERDES_10GQXG
     swconfig dev switch0 set serdes_reset 0
     # 1G / 100M
     swconfig dev switch0 set serdes0_force_mode 4    # SERDES_1000BASEX
     swconfig dev switch0 set serdes_reset 0
     swconfig dev switch0 set serdes0_force_mode 5    # SERDES_100FX
     swconfig dev switch0 set serdes_reset 0
     ```
   - 官方固件速率枚举（前端 JS 反编译）：0=10G / 1=2.5G / 2=1000M / 3=100M，配置存
     `/etc/config/rtlgsw` 第 8 个 `config port` 块的 `option mode`，写入后需重启生效。
   - 已打驱动补丁 `0001-rtl837x-make-sfp-probe-optional.patch`：无 `sfp` 属性时跳过
     SFP bus 探测，消除误导性的 "unable to attach SFP bus" 错误日志（未来若硬件支持
     完整 SFP，在 DTS 加 `sfp = <&sfpX>` 即可启用）。
   - 2.5G 光模块实测：默认 10G 配置下不协商；swconfig 切 2.5G + serdes 复位后协商成功
     （官方固件重启后 idx8 p12=5 link UP 2.5G 验证）。
3. **xs2184 PSE（PoE）驱动**：仅 AC1 机型使用，AC5S 不需要，未包含。
4. RTL8238B 节点保留（官方 DTS 有），但内核暂无对应驱动，不影响启动
   （i2c 探测失败会打印一条错误，无害；如在意可先注释掉）。

## 依赖仓库与提交

| 来源 | 提交 | 说明 |
|---|---|---|
| RuijieNetworksCommunity/rtl837x-gsw-driver | `a1650c6` | RTL8373 驱动源码（**swconfig 路线，本集成采用**），含 6.18 适配（ad6877c） |
| RuijieNetworksCommunity/rtl837x-dsa-driver | `e306c16` | RTL8372N **DSA 路线**驱动（与 gsw 版平行的另一框架）。Readme 注明 RTL8373N+8224 的 port3 serdes 尚未实现，AC5S（RTL8373N 10G）不适用，仅作参考 |
| airjinkela/rtl837x-dsa-driver | `e306c16` | 上者的作者个人镜像，内容逐字节一致（StarField Xu 同人维护，即 gsw 驱动 MAINTAINER） |
| BeeconMini/immortalwrt `25.12.1` | — | AC5S DTS / filogic.mk / 02_network 基准（6.12 时代） |
| WoChen5770/openwrt-7dr7299 | — | 6.18 适配经验（gpio set 签名、sfp compat 补丁） |

## 合并产物（6.18 编译树）

`/home/lwj/immortalwrt-6.18-ac5s`（分支 `ac5s-6.18`）= 上游 `/home/lwj/immortalwrt`（6.18 master）
+ 本 overlay 应用结果。**原树零改动**。

- 构建：`cd /home/lwj/immortalwrt-6.18-ac5s && ./scripts/feeds update -a && ./scripts/feeds install -a`
- 配置：`make menuconfig` → Target: MediaTek → Filogic (MT7987)；Device 勾选
  `BeeconMini SEED AC5S` / `AC5S (NOR)`；依赖 `kmod-switch-rtl837x` 会自动带上
- 编译：`make -j$(nproc)`；产物 `bin/targets/mediatek/filogic/`
- 快速验证编译：`make package/kernel/switch-rtl837x/compile V=s`
  （需先完成 feeds install + defconfig）
