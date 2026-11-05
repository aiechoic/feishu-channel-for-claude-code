#!/usr/bin/env node
/**
 * 重启常驻进程：node bin/restart.mjs [配置文件]
 *
 * 只杀本配置（同一个状态目录）的常驻进程，不动外层循环；外层循环 2 秒后把它重新拉起。
 * 认人靠常驻进程启动时写的 <appId>.pid（pid + 启动时刻）：两者都和进程表对得上才杀，防 pid 被复用后杀错。
 * 杀完等新的常驻进程把自己的 pid 写进来（最多 15 秒），打印新旧 pid。
 * 退出码：0 重启成功；1 没在跑（pid 文件不在或对不上），什么都没杀；2 杀了但等不到新的。
 */
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { paths, readConfig } from '../src/common.mjs'
import proc from '../src/proc.mjs'

const WAIT_MS = Number(process.env.FEISHU_RESTART_WAIT_MS ?? 15_000)
const P = paths(readConfig())

function current() {
  if (!existsSync(P.pidFile)) return null
  try {
    const { pid, start } = JSON.parse(readFileSync(P.pidFile, 'utf8'))
    return pid && start ? { pid: Number(pid), start: String(start) } : null
  } catch {
    return null
  }
}

/** pid 文件里的进程还活着、而且就是写文件的那个 */
const alive = r => r !== null && proc.start(r.pid) === r.start

const old = current()
if (!old) {
  console.log(`常驻进程没在跑：${P.pidFile} 不在或读不出来。外层循环在的话它会自己拉起；不在就重开一次会话。`)
  process.exit(1)
}
if (!alive(old)) {
  console.log(`常驻进程没在跑：${P.pidFile} 里记的 pid ${old.pid} 已经不是那个进程了（已退出或 pid 被复用），没有杀任何进程。`)
  process.exit(1)
}

proc.kill(old.pid)
console.log(`已结束常驻进程 ${old.pid}，等外层循环拉起新的…`)

const deadline = Date.now() + WAIT_MS
for (;;) {
  const now = current()
  if (now && now.pid !== old.pid && alive(now)) {
    console.log(`已重启：旧 pid ${old.pid} → 新 pid ${now.pid}`)
    process.exit(0)
  }
  if (Date.now() > deadline) {
    console.error(`等了 ${WAIT_MS / 1000} 秒没等到新的常驻进程。外层循环可能不在（重开一次会话会把它拉起），看日志 ${P.log}`)
    process.exit(2)
  }
  await sleep(300)
}
