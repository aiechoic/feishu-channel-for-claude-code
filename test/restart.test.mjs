import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(50)
  }
  assert.fail(`超时：${what}`)
}

const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-restart-'))
  writeFileSync(join(dir, 'messages.json'), '[]')
  writeFileSync(join(dir, 'cli_me-seen.txt'), '')
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({ appId: 'cli_me', appSecret: 'x', allow: ['ou_ok'], stateDir: dir, sweepSec: 0, recallPollSec: 0 }))
  const env = { ...process.env, FEISHU_CHANNEL_CONFIG: cfg, FEISHU_ADAPTER: join(HERE, 'fake-feishu.mjs'), FAKE: dir }
  const log = () => (existsSync(join(dir, 'cli_me.log')) ? readFileSync(join(dir, 'cli_me.log'), 'utf8') : '')
  const starts = () => [...log().matchAll(/常驻进程启动 pid=(\d+)/g)].map(m => Number(m[1]))
  const pidFile = join(dir, 'cli_me.pid')
  const recorded = () => (existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : null)
  const restart = (extraEnv = {}) => spawnSync(process.execPath, [join(ROOT, 'bin', 'restart.mjs')], { env: { ...env, ...extraEnv }, encoding: 'utf8' })
  const kill = pid => { try { process.kill(pid, 'SIGKILL') } catch {} }
  const done = async procs => {
    procs.forEach(kill)
    starts().forEach(kill)
    await sleep(200)
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  return { dir, cfg, env, starts, pidFile, recorded, restart, done }
}

test('重启：pid 文件对得上才杀，只杀常驻进程，等到外层循环拉起新的并打印新旧 pid', async () => {
  const t = setup()
  const sup = spawn(process.execPath, [join(ROOT, 'src', 'supervise.mjs')], { env: t.env, stdio: 'ignore' })
  try {
    await until(() => t.starts().length > 0 && t.recorded()?.pid === t.starts()[0], '常驻进程写 pid 文件')
    const old = t.starts()[0]
    assert.ok(t.recorded().start, 'pid 文件带启动时刻')
    const r = t.restart()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const now = t.recorded().pid
    assert.notEqual(now, old)
    assert.match(r.stdout, new RegExp(`已重启：旧 pid ${old} → 新 pid ${now}`))
    await until(() => !isAlive(old), '旧的常驻进程退出')
    assert.ok(isAlive(now), '新的在跑')
    assert.equal(sup.exitCode, null, '外层循环没动')
    assert.ok(isAlive(sup.pid))
  } finally { await t.done([sup.pid]) }
})

test('重启：pid 文件里的启动时刻对不上（pid 被复用）就不杀；文件不在也不杀', async () => {
  const t = setup()
  const daemon = spawn(process.execPath, [join(ROOT, 'src', 'daemon.mjs')], { env: t.env, stdio: 'ignore' })
  try {
    await until(() => t.recorded()?.pid === daemon.pid, '常驻进程写 pid 文件')
    const real = t.recorded()
    writeFileSync(t.pidFile, JSON.stringify({ pid: real.pid, start: `${real.start}0` }))
    const r = t.restart()
    assert.equal(r.status, 1)
    assert.match(r.stdout, /已经不是那个进程了/)
    await sleep(300)
    assert.ok(isAlive(daemon.pid), 'pid 对得上但启动时刻对不上：不杀')

    rmSync(t.pidFile)
    const r2 = t.restart()
    assert.equal(r2.status, 1)
    assert.match(r2.stdout, /没在跑/)
    assert.ok(isAlive(daemon.pid))
  } finally { await t.done([daemon.pid]) }
})

test('重启：没有外层循环时杀了等不到新的，报错退出码 2', async () => {
  const t = setup()
  const daemon = spawn(process.execPath, [join(ROOT, 'src', 'daemon.mjs')], { env: t.env, stdio: 'ignore' })
  try {
    await until(() => t.recorded()?.pid === daemon.pid, '常驻进程写 pid 文件')
    const r = t.restart({ FEISHU_RESTART_WAIT_MS: '1500' })
    assert.equal(r.status, 2, r.stdout + r.stderr)
    assert.match(r.stderr, /没等到新的常驻进程/)
    await until(() => daemon.exitCode !== null || daemon.signalCode !== null, '常驻进程被杀')
  } finally { await t.done([daemon.pid]) }
})
