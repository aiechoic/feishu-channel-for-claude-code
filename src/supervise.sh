#!/bin/sh
# 外层循环：常驻进程退出后自动拉起。用法 supervise.sh <lock 文件>，同一把锁只跑一份。
here=$(dirname "$(readlink -f "$0")")
exec 9>"$1"
flock -n 9 || exit 0
while :; do
  node "$here/daemon.mjs" 9>&-
  # 78：核心权限缺失，重启也没用，等久一点
  [ $? -eq 78 ] && sleep 300
  sleep 2
done
