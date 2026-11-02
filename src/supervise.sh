#!/bin/sh
# 外层循环：常驻进程退出后自动拉起。用法 supervise.sh <lock 文件>，同一把锁只跑一份。
here=$(dirname "$(readlink -f "$0")")
exec 9>"$1"
flock -n 9 || exit 0
while :; do
  node "$here/daemon.mjs" 9>&-
  sleep 2
done
