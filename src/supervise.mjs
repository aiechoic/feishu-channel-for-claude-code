#!/usr/bin/env node
/**
 * 外层循环：常驻进程退出后自动拉起。桥在会话初始化时以分离进程起它，配置走环境变量 FEISHU_CHANNEL_CONFIG。
 *
 * 同一个状态目录只跑一份：占住一个本机端点（Unix socket / Windows 命名管道），占不到就说明已经有一份在跑，直接退出。
 * Unix socket 文件在进程被 SIGKILL 后会残留：占不到时先连一下，连不上就是残留，删掉再占。
 * 旧版外层循环是 `sh supervise.sh`（flock 锁文件）：升级时它可能还活着，看锁还被占着就让位，免得两份常驻进程抢同一个端点。
 * 常驻进程以退出码 78 退出（核心权限缺失）时重启也没用，等 5 分钟再拉；其余 2 秒后重拉。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { HERE, paths, readConfig } from './common.mjs'

const P = paths(readConfig())
mkdirSync(P.dir, { recursive: true })

/** 旧版 supervise.sh 还占着 flock 锁吗（只看 Linux；没有 flock 命令就当没有） */
function legacyRunning() {
  if (P.pipe || !existsSync(P.lock)) return false
  const r = spawnSync('flock', ['-n', P.lock, 'true'], { stdio: 'ignore' })
  return !r.error && r.status === 1
}

/** 能连上 = 有一份活着的外层循环 */
const alive = () => new Promise(resolve => {
  const c = connect(P.superSock)
  c.on('connect', () => { c.destroy(); resolve(true) })
  c.on('error', () => resolve(false))
})

function hold() {
  return new Promise((resolve, reject) => {
    const server = createServer(s => s.end())
    server.once('error', reject)
    server.listen(P.superSock, () => resolve(server))
  })
}

async function claim() {
  try {
    return await hold()
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || P.pipe || await alive()) return null
    rmSync(P.superSock, { force: true })
    return hold().catch(() => null)
  }
}

if (legacyRunning()) process.exit(0)
const server = await claim()
if (!server) process.exit(0)

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0))

const wait = ms => new Promise(r => setTimeout(r, ms))
for (;;) {
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [join(HERE, 'daemon.mjs')], { stdio: 'ignore', windowsHide: true })
    child.on('exit', c => resolve(c))
    child.on('error', () => resolve(null))
  })
  if (code === 78) await wait(300_000)
  await wait(2000)
}
