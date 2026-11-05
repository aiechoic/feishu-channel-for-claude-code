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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-supervise-'))
  writeFileSync(join(dir, 'messages.json'), '[]')
  writeFileSync(join(dir, 'cli_me-seen.txt'), '')
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({ appId: 'cli_me', appSecret: 'x', allow: ['ou_ok'], stateDir: dir, sweepSec: 0, recallPollSec: 0 }))
  const env = { ...process.env, FEISHU_CHANNEL_CONFIG: cfg, FEISHU_ADAPTER: join(HERE, 'fake-feishu.mjs'), FAKE: dir }
  const log = () => (existsSync(join(dir, 'cli_me.log')) ? readFileSync(join(dir, 'cli_me.log'), 'utf8') : '')
  const starts = () => [...log().matchAll(/常驻进程启动 pid=(\d+)/g)].map(m => Number(m[1]))
  const supervise = () => spawn(process.execPath, [join(ROOT, 'src', 'supervise.mjs')], { env, stdio: 'ignore' })
  const kill = pid => { try { process.kill(pid, 'SIGKILL') } catch {} }
  const done = () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  return { dir, env, log, starts, supervise, kill, done }
}

test('外层循环：同一个状态目录只跑一份；常驻进程被杀后重新拉起', async () => {
  const t = setup()
  const first = t.supervise()
  try {
    await until(() => t.starts().length === 1, '常驻进程启动')
    const second = t.supervise()
    const code = await new Promise(r => second.on('exit', r))
    assert.equal(code, 0, '第二份占不到端点，直接退出')
    t.kill(t.starts()[0])
    await until(() => t.starts().length === 2, '被杀后重新拉起')
    assert.ok(first.exitCode === null, '第一份还在')
  } finally {
    t.kill(first.pid)
    t.starts().forEach(t.kill)
    await sleep(200)
    t.done()
  }
})

test('外层循环被 SIGKILL 后，新的一份能接手（Unix socket 残留文件会被认出来）', async () => {
  const t = setup()
  const first = t.supervise()
  let second
  try {
    await until(() => t.starts().length === 1, '常驻进程启动')
    t.kill(first.pid)
    await new Promise(r => first.on('exit', r))
    t.starts().forEach(t.kill)
    second = t.supervise()
    await until(() => t.starts().length === 2, '新的一份拉起常驻进程')
    assert.ok(second.exitCode === null)
  } finally {
    if (second) t.kill(second.pid)
    t.starts().forEach(t.kill)
    await sleep(200)
    t.done()
  }
})

test('旧版 supervise.sh 还占着 flock 锁时让位', { skip: (process.platform === 'win32' || spawnSync('flock', ['--version']).error) && '只在有 flock 的 Linux 上' }, async () => {
  const t = setup()
  const holder = spawn('flock', [join(t.dir, 'cli_me.lock'), 'sleep', '30'], { stdio: 'ignore' })
  try {
    await sleep(300)
    const s = t.supervise()
    const code = await new Promise(r => s.on('exit', r))
    assert.equal(code, 0)
    assert.equal(t.starts().length, 0, '不另起常驻进程')
  } finally {
    holder.kill('SIGKILL')
    await sleep(100)
    t.done()
  }
})

test('setup：hook 命令不带 shell 专属的环境变量前缀，配置文件当参数传', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-setup-'))
  try {
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, '{}')
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'setup.mjs')], { env: { ...process.env, FEISHU_CHANNEL_CONFIG: cfg }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command
    assert.doesNotMatch(cmd, /FEISHU_CHANNEL_CONFIG=/)
    assert.equal(cmd, `node ${JSON.stringify(join(ROOT, 'src', 'hook.mjs').replaceAll('\\', '/'))} ${JSON.stringify(cfg.replaceAll('\\', '/'))}`)
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    assert.equal(mcp.mcpServers.feishu.env.FEISHU_CHANNEL_CONFIG, cfg)
    // hook 照这条命令跑得起来：常驻进程不在时静默退出 0
    const { FEISHU_CHANNEL_CONFIG: _, ...bare } = process.env
    const hook = spawnSync(process.execPath, [join(ROOT, 'src', 'hook.mjs'), cfg], { input: '{}', encoding: 'utf8', env: bare })
    assert.equal(hook.status, 1, '配置是空对象 → 缺 appId 报错（说明读的确实是参数里的那个文件）')
    assert.match(hook.stderr, /缺 appId/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
