# SPDX-License-Identifier: GPL-2.0-only
#
# Realtek RTL837x (RTL8372N / RTL8373N) switch driver
# 来源: https://github.com/RuijieNetworksCommunity/rtl837x-gsw-driver
# 固定提交 a1650c6 (2026-05-25, 含 "fix build with linux 6.18.x")
# 该提交已内置 6.18 兼容: gpio_chip.set 返回 int 的条件编译、<linux/string.h>
#
# 说明: 这是社区开源的 RTL8373 驱动 (swconfig 框架)。
# BeeconMini 官方驱动为闭源二进制 (compatible "realtek,rtl8373n" + mediatek,mdio
# 绑定, 仅提供 6.12.94/6.12.95 预编译 .ko), 无 6.18 可用版本, 故以本驱动替代。
# 设备树绑定不同, 见 overlay 内 DTS 文件 (switch@1d 挂在 &mdio 下)。

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

PKG_NAME:=switch-rtl837x
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/RuijieNetworksCommunity/rtl837x-gsw-driver.git
PKG_SOURCE_DATE:=2026-05-25
PKG_SOURCE_VERSION:=a1650c6ac6e658b7ee7594ec8283d94205a001fe
# PKG_MIRROR_HASH: 首次构建下载时会打印实际 hash, 回填此处可启用 dl 缓存

PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=StarField Xu <air_jinkela@163.com>

PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define KernelPackage/switch-rtl837x
  SUBMENU:=Network Devices
  TITLE:=Realtek RTL837x switch driver (RTL8372N/RTL8373N)
  FILES:=$(PKG_BUILD_DIR)/src/rtl837x_gsw.ko
  AUTOLOAD:=$(call AutoLoad,42,rtl837x_gsw,1)
  DEPENDS:=+kmod-swconfig
endef

define Build/Compile
	+$(KERNEL_MAKE) $(PKG_JOBS) \
		M="$(PKG_BUILD_DIR)/src" \
		EXTRA_CFLAGS="$(EXTRA_CFLAGS)" \
		CONFIG_RTL837x_GSW=m \
		CONFIG_RTL837x_GSW_PORT_MIB_FEATURE=y \
		modules
endef

$(eval $(call KernelPackage,switch-rtl837x))
