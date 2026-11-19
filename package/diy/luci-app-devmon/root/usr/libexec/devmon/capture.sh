#!/bin/sh
# 对单个设备抓包，到达时长或文件大小上限后自动停止
#
# 用法: capture.sh <dir> <id> <iface> <mac> <max_kb> <duration_s> [filter]
# 参数由 rpcd 插件校验后传入；filter 作为一个参数交给 tcpdump 解析，不经过 shell
# 产物：<id>.pcap 原始包，<id>.txt 逐包解析文本（供页面实时预览），<id>.log tcpdump 的报错和统计
# 运行期间 <id>.pid 存 tcpdump 的 pid，结束后删除

# rpcd 派生的进程 PATH 不一定完整，tcpdump 可能在 /usr/bin 或 /usr/sbin
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

dir=$1 id=$2 iface=$3 mac=$4 max_kb=$5 duration=$6 filter=$7

file="$dir/$id.pcap"
text="$dir/$id.txt"
expr="ether host $mac"
[ -n "$filter" ] && expr="$expr and ($filter)"

# -U 每个包立即写入 pcap，--print -l 同时逐行输出解析结果，页面看到的都是实时的
tcpdump -i "$iface" -s 0 -U -w "$file" --print -l -nn -tttt "$expr" >"$text" 2>"$dir/$id.log" &
pid=$!
echo "$pid" >"$dir/$id.pid"

elapsed=0
while kill -0 "$pid" 2>/dev/null; do
	sleep 1
	elapsed=$((elapsed + 1))

	# 文本预览和 pcap 都在内存盘里，一起计入大小上限
	size_kb=0
	[ -f "$file" ] && size_kb=$(($(wc -c <"$file") / 1024))
	[ -f "$text" ] && size_kb=$((size_kb + $(wc -c <"$text") / 1024))

	if [ "$duration" -gt 0 ] && [ "$elapsed" -ge "$duration" ] || [ "$size_kb" -ge "$max_kb" ]; then
		kill "$pid" 2>/dev/null
		break
	fi
done

wait "$pid" 2>/dev/null
rm -f "$dir/$id.pid"
