. /lib/functions.sh

# JDCloud RE-SS-01 uses a dual-boot GPT (HLOS/rootfs + HLOS_1/rootfs_1).
# The byte at offset 148 of 0:BOOTCONFIG selects the slot U-Boot boots from
# (same layout as upstream OpenWrt's jdcloud,re-ss-01 handling).
#
# Write to the slot that is currently booted, so the new firmware is what
# actually comes up after reboot. The 2048M GPT template only enlarges the
# primary rootfs, so if the secondary rootfs is too small for the image plus
# its overlay we fall back to the primary slot and point BOOTCONFIG (and its
# backup copy 0:BOOTCONFIG1, if present) back at slot 0.

JDCLOUD_BOOTCONFIG_OFFS=148
# room for the loop-mounted rootfs_data behind the squashfs
JDCLOUD_OVERLAY_MIN=$((64 * 1024 * 1024))

jdcloud_bootconfig_get_slot() {
	local part=$(find_mmc_part "0:BOOTCONFIG")

	[ -n "$part" ] || { echo 0; return; }
	hexdump -v -e '1/1 "%d"' -n 1 -s $JDCLOUD_BOOTCONFIG_OFFS "$part" 2>/dev/null || echo 0
}

jdcloud_bootconfig_set_slot0() {
	local name part

	for name in "0:BOOTCONFIG" "0:BOOTCONFIG1"; do
		part=$(find_mmc_part "$name")
		[ -n "$part" ] || continue
		printf '\000' | dd of="$part" bs=1 seek=$JDCLOUD_BOOTCONFIG_OFFS \
			count=1 conv=notrunc >/dev/null 2>&1
	done
	sync
}

jdcloud_part_size() {
	local dev=$(basename "$1")

	[ -r "/sys/class/block/$dev/size" ] || { echo 0; return; }
	echo $(($(cat /sys/class/block/$dev/size) * 512))
}

jdcloud_do_upgrade() {
	local tar_file="$1"
	local slot=$(jdcloud_bootconfig_get_slot)

	kernelname="0:HLOS"
	rootfsname="rootfs"

	if [ "$slot" = "1" ]; then
		local kpart=$(find_mmc_part "0:HLOS_1")
		local rpart=$(find_mmc_part "rootfs_1")
		local board_dir=$(tar tf "$tar_file" | grep -m 1 '^sysupgrade-.*/$')
		local need=$(tar xf "$tar_file" ${board_dir%/}/root -O | wc -c)

		need=$((need + JDCLOUD_OVERLAY_MIN))
		if [ -n "$kpart" ] && [ -n "$rpart" ] && \
		   [ "$(jdcloud_part_size "$rpart")" -ge "$need" ]; then
			echo "BOOTCONFIG selects slot 1, upgrading HLOS_1/rootfs_1"
			kernelname="0:HLOS_1"
			rootfsname="rootfs_1"
		else
			echo "BOOTCONFIG selects slot 1 but rootfs_1 is missing or too small,"
			echo "upgrading slot 0 and switching BOOTCONFIG back to slot 0"
			jdcloud_bootconfig_set_slot0
		fi
	fi

	mmc_do_upgrade "$tar_file"
}
