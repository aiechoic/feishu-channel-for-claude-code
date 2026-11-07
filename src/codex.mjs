#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { configFile, HERE, paths, readConfig } from './common.mjs'
import { CodexRpc } from './codex-rpc.mjs'
import { CodexSession } from './codex-session.mjs'
import { CodexCommands } from './codex-proc.mjs'
import proc from './proc.mjs'

const cfg = readConfig()
const P = paths(cfg)
mkdirSync(P.dir, { recursive: true })
const sessionFile = join(P.dir, `${cfg.appId}-codex.json`)
let lock
// 沿用 supervise 的状态命名空间，第二个接收端不能接管桥接。
const lockPath = P.superSock + '-codex'
async function claim() {
  lock = createServer(s => s.end())
  await new Promise((ok, fail) => { lock.once('error', fail); lock.listen(lockPath, ok) })
}
try { await claim() } catch (e) {
  if (e.code !== 'EADDRINUSE' || P.pipe) throw e
  const alive = await new Promise(ok => {
    const c = connect(lockPath)
    c.on('connect', () => { c.destroy(); ok(true) })
    c.on('error', () => ok(false))
  })
  if (alive) throw new Error('已有 Codex receiver 在运行')
  rmSync(lockPath, { force: true })
  await claim()
}
const saved = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : {}
const rpc = new CodexRpc(cfg.codex?.command ?? 'codex', cfg.codex?.args)
let link, timer, stopped = false, session
let accepting = false
let bufferedHooks = []
function persist() {
  const tmp = sessionFile + '.tmp'
  writeFileSync(tmp, JSON.stringify({ threadId: session.threadId, accepted: [...session.accepted] }), { mode: 0o600 })
  renameSync(tmp, sessionFile)
}
const send = m => link?.write(`${JSON.stringify(m)}\n`)
function exit(code) {
  if (stopped) return
  stopped = true
  clearInterval(timer)
  link?.destroy()
  rpc.close()
  lock.close()
  process.exit(code)
}
rpc.on('disconnect', e => { console.error(e.message); exit(1) })
process.on('unhandledRejection', e => { console.error(e.message); exit(1) })
await rpc.initialize()
const options = {
  cwd: resolve(cfg.codex?.cwd ?? process.cwd()),
  config: { mcp_servers: { feishu: { command: process.execPath, args: [join(HERE, 'bridge.mjs')], env: { FEISHU_CHANNEL_CONFIG: resolve(configFile()), FEISHU_CODEX_TOOLS_ONLY: '1' } } } },
}
// 模型与审批权限默认沿用会话，仅接受操作者的显式配置。
if (cfg.codex?.model) options.model = cfg.codex.model
const attached = cfg.codex?.threadId
const { thread } = await rpc.request(attached || saved.threadId ? 'thread/resume' : 'thread/start', attached
  ? { threadId: attached, excludeTurns: false }
  : { ...options, ...(saved.threadId ? { threadId: saved.threadId } : {}) })
let commandRoot = rpc.child.pid
if ((cfg.codex?.args ?? ['app-server', 'proxy']).includes('proxy')) {
  const daemonFile = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-daemon', 'daemon.pid')
  commandRoot = JSON.parse(readFileSync(daemonFile, 'utf8')).pid
  const root = proc.info(commandRoot)
  if (!root || !/^codex(?:\.exe)?$/i.test(root.name) || !root.cmd.includes('app-server')) throw new Error('无法验证共享 Codex daemon 的进程归属')
}
session = new CodexSession(rpc, thread.id, saved.threadId === thread.id ? saved.accepted : [], new CodexCommands(proc, commandRoot, process.platform, Date.now, {
  threadId: thread.id,
  report: message => console.log(`Codex command cleanup: ${message}`),
}))
session.on('killed', ids => console.log(`Codex command cleanup: killed ${ids.join(' ')}`))
session.turnId = thread.turns?.findLast(t => t.status === 'inProgress')?.id ?? null
session.on('accepted', persist)
session.on('failure', e => { console.error(e.message); exit(1) })
session.on('hook', h => accepting ? bufferedHooks.push(h) : send(h))
persist()
console.log(`Codex thread ${thread.id}; state ${sessionFile}`)
function dial() {
  if (stopped) return
  const c = connect(P.sock)
  c.on('error', () => {})
  c.on('connect', () => {
    link = c
    send({ t: 'hello', claudePid: rpc.child.pid, bridgePid: process.pid })
    if (session.turnId) send({ t: 'hook', event: 'UserPromptSubmit' })
  })
  createInterface({ input: c }).on('error', () => {}).on('line', async line => {
    try {
      const m = JSON.parse(line)
      if (m.t !== 'push') return
      accepting = true
      const previousTurn = session.turnId
      await session.accept(m)
      // RPC 接受投递后先确认，再仅为新轮次发送唤醒 hook。
      send({ t: 'ack', pushId: m.pushId })
      const confirmation = session.deliveryHook(previousTurn)
      if (confirmation) send(confirmation)
      accepting = false
      for (const hook of bufferedHooks) send(hook)
      bufferedHooks = []
    } catch (e) {
      // 投递结果不明时不确认，恢复前由操作者核对会话。
      console.error(`Codex delivery failed: ${e.message}`)
      exit(1)
    }
  })
  c.on('close', () => { if (link === c) link = null; if (!stopped) setTimeout(dial, 1000) })
}
let lastStop = '', lastHeartbeat = 0
timer = setInterval(() => {
  let stop = ''
  try { stop = `${statSync(P.stopFlag).mtimeMs}:${readFileSync(P.stopFlag, 'utf8')}` } catch {}
  if (stop && stop !== lastStop) {
    lastStop = stop
    session.interrupt().catch(e => { console.error(e.message); exit(1) })
  } else if (!stop) lastStop = ''
  if (session.turnId && !session.stopped && Date.now() - lastHeartbeat > 10_000) {
    lastHeartbeat = Date.now()
    session.heartbeat()
  }
}, 500)
spawn(process.execPath, [join(HERE, 'supervise.mjs')], { env: { ...process.env, FEISHU_CHANNEL_CONFIG: resolve(configFile()) }, detached: true, stdio: 'ignore', windowsHide: true }).unref()
dial()
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => exit(0))
