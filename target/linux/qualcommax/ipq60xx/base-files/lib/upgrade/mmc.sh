#
# Copyright (C) 2016 lede-project.org
#

# Generic eMMC upgrade helper.
#
# Add a device entry in platform.sh, define "kernelname" and "rootfsname"
# and then call mmc_do_upgrade. After the kernel and the rootfs have been
# written, a loop device (used as overlay) is set up on top of the rootfs
# partition, right behind the squashfs.
#
# This requires a padded rootfs image, i.e. append "pad-to 64k" to the
# image recipe. Based on the ipq806x zyxel.sh mmc upgrade.

. /lib/functions.sh

mmc_do_upgrade() {
	local tar_file="$1"
	local rootfs=
	local kernel=

	[ -z "$kernel" ] && kernel=$(find_mmc_part ${kernelname})
	[ -z "$rootfs" ] && rootfs=$(find_mmc_part ${rootfsname})

	[ -z "$kernel" ] && echo "Upgrade failed: kernel partition not found! Rebooting..." && reboot -f
	[ -z "$rootfs" ] && echo "Upgrade failed: rootfs partition not found! Rebooting..." && reboot -f

	mmc_do_flash "$tar_file" "$kernel" "$rootfs"

	return 0
}

# Offset of the loop-mounted rootfs_data behind the squashfs on "$1".
# Must match _get_overlay_partition_loop in /lib/functions/istoreos-boot.sh,
# which takes the squashfs size from `df -k /`: statfs reports bytes_used
# rounded up to the squashfs block size, then aligned to 4 KiB. Using the
# (64 KiB padded) image size instead lands the backup at a different offset
# and the saved config is lost on the next boot.
mmc_overlay_offset() {
	local dev="$1" magic bs used

	magic=$(dd if="$dev" bs=4 count=1 2>/dev/null | hexdump -v -e '1/4 "%08x"')
	[ "$magic" = "73717368" ] || return 1
	bs=$(dd if="$dev" bs=4 skip=3 count=1 2>/dev/null | hexdump -v -e '1/4 "%u"')
	used=$(dd if="$dev" bs=4 skip=10 count=1 2>/dev/null | hexdump -v -e '1/4 "%u"')
	[ -n "$bs" ] && [ "$bs" -gt 0 ] && [ -n "$used" ] && [ "$used" -gt 0 ] || return 1

	used=$(( (used + bs - 1) / bs * bs ))
	echo $(( (used + 4095) / 4096 * 4096 ))
}

mmc_do_flash() {
	local tar_file=$1
	local kernel=$2
	local rootfs=$3

	# make sure nothing is bound
	losetup --detach-all || {
		echo "Failed to detach all loop devices. Skip this try."
		reboot -f
	}

	# use the first found directory in the tar archive
	local board_dir=$(tar tf $tar_file | grep -m 1 '^sysupgrade-.*/$')
	board_dir=${board_dir%/}

	echo "flashing kernel to $kernel"
	tar xf $tar_file ${board_dir}/kernel -O >"$kernel"

	echo "flashing rootfs to ${rootfs}"
	tar xf $tar_file ${board_dir}/root -O >"${rootfs}"

	# a padded rootfs is needed for overlay fs creation
	local offset=$(mmc_overlay_offset "$rootfs")
	[ -n "$offset" ] || offset=$(tar xf $tar_file ${board_dir}/root -O | wc -c)
	echo "rootfs_data offset: ${offset}"
	[ $offset -lt 65536 ] && {
		echo "Wrong size for rootfs: $offset"
		sleep 10
		reboot -f
	}

	# mount loop for rootfs_data
	local loopdev="$(losetup -f)"
	losetup -o $offset $loopdev $rootfs || {
		echo "Failed to mount looped rootfs_data."
		sleep 10
		reboot -f
	}

	# iStoreOS 的 mount_root 只认 LABEL=etc 的 overlay（否则当作未格式化
	# 重新 mkfs），并以 <overlay>/upper 作为 overlayfs 的 upperdir；
	# preinit 从合并后的根目录取 /sysupgrade.tgz，所以备份要放进 upper/。
	echo "Format new rootfs_data at position ${offset}."
	mkfs.ext4 -q -j -F -L etc $loopdev
	mkdir -p /tmp/new_root
	mount -t ext4 $loopdev /tmp/new_root && {
		mkdir -p /tmp/new_root/upper /tmp/new_root/work
		[ -n "$UPGRADE_BACKUP" ] && [ -f "$UPGRADE_BACKUP" ] && {
			echo "Saving config to rootfs_data at position ${offset}."
			cp -v "$UPGRADE_BACKUP" "/tmp/new_root/upper/$BACKUP_FILE"
		}
		umount /tmp/new_root
	}

	# cleanup
	losetup -d $loopdev >/dev/null 2>&1
	sync
	umount -a
	reboot -f
}
