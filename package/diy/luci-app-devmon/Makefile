
include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI device manager, traffic monitor and packet capture
LUCI_DEPENDS:=+luci-base +ucode +ucode-mod-fs +ucode-mod-uci +nftables-json +tcpdump +ip-full
LUCI_PKGARCH:=all
PKG_VERSION:=1.1.0
PKG_RELEASE:=2
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=xuxh <xuxh.linux@gmail.com>

define Package/luci-app-devmon/conffiles
/etc/config/devmon
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
