import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { paths } from '../src/common.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IS_WIN = process.platform === 'win32'

const msg = (id, sender = 'ou_ok', extra = {}) => ({
  chat_id: 'oc_group', message_id: id, content: `正文 ${id}`, msg_type: 'text', create_time: '2026-11-01 10:00',
  sender: { id: sender, name: sender, sender_type: 'user' }, ...extra,
})

async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(50)
  }
  assert.fail(`超时：${what}`)
}

class Rig {
  constructor(extra = {}) {
    this.dir = mkdtempSync(join(tmpdir(), 'feishu-channel-'))
    this.messages = []
    this.write()
    writeFileSync(join(this.dir, 'cli_me-seen.txt'), 'om_old')
    this.cfg = join(this.dir, 'config.json')
    writeFileSync(this.cfg, JSON.stringify({
      appId: 'cli_me', appSecret: 'x', allow: ['ou_ok', 'cli_lead'], stateDir: this.dir, sweepSec: 0, recallPollSec: 0.2, scheduleTickSec: 0.05,
      cardDebounceSec: 0.1, statusChat: 'oc_group', ...extra,
    }))
    this.env = { ...process.env, FEISHU_CHANNEL_CONFIG: this.cfg, FEISHU_ADAPTER: join(HERE, 'fake-feishu.mjs'), FAKE: this.dir }
    this.sock = paths({ appId: 'cli_me', stateDir: this.dir }).sock
    this.pushes = []
  }

  write() { writeFileSync(join(this.dir, 'messages.json'), JSON.stringify(this.messages)) }
  file(name) { const f = join(this.dir, name); return existsSync(f) ? readFileSync(f, 'utf8') : '' }
  add(...ms) { this.messages.push(...ms); this.write(); writeFileSync(join(this.dir, 'fire'), 'oc_group') }

  startDaemon() {
    this.daemon = spawn('node', [join(ROOT, 'src', 'daemon.mjs')], { env: this.env, stdio: 'ignore' })
    return until(() => this.file('cli_me.log').includes('ready') || this.file('consume.log'), '常驻进程启动')
  }

  /** 假桥：claudePid 用给定值，自动确认推送 */
  async bridge(claudePid = 999999) {
    await until(() => this.file('cli_me.log').includes('常驻进程启动'), '端点就绪')
    const c = connect(this.sock)
    createInterface({ input: c }).on('line', l => {
      const m = JSON.parse(l)
      if (m.t !== 'push') return
      this.pushes.push(m)
      c.write(`${JSON.stringify({ t: 'ack', pushId: m.pushId })}\n`)
    })
    c.write(`${JSON.stringify({ t: 'hello', claudePid, bridgePid: 1 })}\n`)
    this.link = c
    await until(() => this.file('cli_me.log').includes('桥已连上'), '桥连上')
  }

  hook(event, extra = {}) {
    const input = JSON.stringify({ hook_event_name: event, tool_use_id: 't1', ...extra })
    return spawnSync('node', [join(ROOT, 'src', 'hook.mjs')], { env: this.env, input, encoding: 'utf8' })
  }

  log() { return this.file('cli_me.log') }

  close() {
    this.link?.destroy()
    this.daemon?.kill('SIGKILL')
    // Windows 上刚杀掉的进程可能还占着日志文件，删目录要重试几次
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

async function rig(fn, extra) {
  const r = new Rig(extra)
  try {
    await r.startDaemon()
    await r.bridge()
    await fn(r)
  } finally {
    r.close()
  }
}

test('闲时直接送达，白名单外丢弃，自己发的跳过', () => rig(async r => {
  r.add(msg('om_1'), msg('om_x', 'ou_bad'), msg('om_me', 'cli_me'))
  await until(() => r.pushes.length === 1, '送达')
  assert.equal(r.pushes[0].meta.message_id, 'om_1')
  await until(() => r.log().includes('丢弃 om_x'), '白名单外丢弃')
  await until(() => r.file('reactions.txt').includes('om_1 OneSecond'), '处理中表情')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await until(() => r.file('reactions.txt').includes('om_1 CheckMark'), '完成表情')
}))

test('忙时白名单消息立刻送出，不等 Stop；白名单外照样丢；Stop 后打完成表情', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await until(() => r.log().includes('标忙'), '标忙')
  r.add(msg('om_1'), msg('om_bad', 'ou_bad'))
  await until(() => r.pushes.length === 1, '忙时送达')
  assert.equal(r.pushes[0].meta.message_id, 'om_1')
  assert.equal(r.pushes[0].meta.retry, undefined)
  await until(() => r.log().includes('忙时送出 1 条：om_1'), '桥确认后记忙时送出')
  await until(() => r.log().includes('丢弃 om_bad'), '白名单外丢弃')
  await until(() => r.file('reactions.txt').includes('om_1 OneSecond'), '处理中表情')
  assert.doesNotMatch(r.file('reactions.txt'), /om_1 GLANCE/)
  r.add(msg('om_2'))
  await until(() => r.pushes.length === 2, '第二条忙时送达')
  r.hook('PostToolUse', { tool_name: 'Bash' })
  r.hook('Stop')
  await until(() => r.file('reactions.txt').includes('om_2 CheckMark'), '完成表情')
  assert.match(r.file('reactions.txt'), /om_1 CheckMark/)
  await sleep(300)
  assert.equal(r.pushes.length, 2, '忙时送过的 Stop 后不再送')
}))

test('忙时送出中到达的消息：确认后接着送，同一会话合并', async () => {
  const r = new Rig()
  try {
    await r.startDaemon()
    await r.bridge()
    r.hook('UserPromptSubmit')
    r.link.destroy() // 换一个不自动确认的桥
    await until(() => r.log().includes('桥断开'), '桥断开')
    const c = connect(r.sock)
    const got = []
    createInterface({ input: c }).on('line', l => { const m = JSON.parse(l); if (m.t === 'push') got.push(m) })
    c.write(`${JSON.stringify({ t: 'hello', claudePid: 999999, bridgePid: 1 })}\n`)
    await until(() => r.log().split('桥已连上').length === 3, '桥重连')
    r.hook('UserPromptSubmit')
    r.add(msg('om_1'))
    await until(() => got.length === 1, '第一条送出')
    r.add(msg('om_2'), msg('om_3'))
    await until(() => r.file('reactions.txt').includes('om_3 GLANCE'), '送出中排队')
    assert.equal(got.length, 1)
    c.write(`${JSON.stringify({ t: 'ack', pushId: got[0].pushId })}\n`)
    await until(() => got.length === 2, '确认后接着送')
    assert.equal(got[1].meta.message_id, 'om_2,om_3')
    assert.equal(got[1].meta.merged, '2')
    c.destroy()
  } finally { r.close() }
})

test('忙但心跳超时按闲处理并送出排队的定时', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '超时后送' })
  await until(() => r.log().includes('定时 s1 触发'), '到点')
  assert.equal(r.pushes.length, 0)
  await until(() => r.log().includes('标闲：心跳超时'), '超时标闲')
  await until(() => r.pushes.length === 1, '送达')
}, { busyTimeoutSec: 0.1 }))

test('会话离线时排队，新会话连上后送出', async () => {
  const r = new Rig()
  try {
    await r.startDaemon()
    r.add(msg('om_1'))
    await until(() => r.file('cli_me-state.json').includes('om_1'), '入队')
    assert.equal(r.pushes.length, 0)
    await r.bridge()
    await until(() => r.pushes.length === 1, '送达')
  } finally { r.close() }
})

test('「停」：清空队列、写标记、拦工具、回执；句子里带停字不触发；停之前送出的补充进会话不解除；停下前到的新消息等闲再送', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '排队的定时' })
  await until(() => r.log().includes('定时 s1 触发'), '定时排队')
  r.add(msg('om_no', 'ou_ok', { content: '先别停' }))
  await until(() => r.pushes.length === 1, '带停字的句子忙时照常送')
  r.add(msg('om_bad', 'ou_bad', { content: '停' }))
  await until(() => r.log().includes('丢弃 om_bad'), '白名单外的停被丢弃')
  assert.ok(!existsSync(join(r.dir, 'cli_me.stop')))
  r.add(msg('om_stop', 'ou_ok', { content: '停' }))
  await until(() => existsSync(join(r.dir, 'cli_me.stop')), '停止标记')
  await until(() => r.file('sent.txt').includes('已停，丢了 1 条（含定时 s1）'), '回执')
  await until(() => r.file('reactions.txt').includes('om_no CrossMark'), '忙时送过的也标已停')
  r.hook('UserPromptSubmit') // 停之前忙时送出的 om_no 这时才进会话
  assert.ok(existsSync(join(r.dir, 'cli_me.stop')), '停之前送出的补充进会话不清停止标记')
  const out = r.hook('PreToolUse', { tool_name: 'Bash' })
  assert.equal(JSON.parse(out.stdout).continue, false)
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny')
  r.add(msg('om_new'))
  await until(() => r.file('reactions.txt').includes('om_new GLANCE'), '停下前到的新消息排队')
  assert.equal(r.pushes.length, 1, '停止标记在时不往要结束的这一轮里送')
  r.hook('Stop')
  await until(() => !existsSync(join(r.dir, 'cli_me.stop')), '标记清掉')
  await until(() => r.pushes.length === 2, '闲后送达')
  assert.equal(r.pushes[1].meta.message_id, 'om_new')
}))

// 真起一个 bash 子进程当工具。Windows 上的查表与杀树由 proc.test.mjs 用模拟的 PowerShell 输出覆盖。
// Windows 版 Claude Code 跑命令的工具叫 PowerShell：工具名换成它也要找得到、杀得掉（这里的子进程仍是 bash，只验工具名那一侧）
for (const tool of ['Bash', 'PowerShell']) {
  test(`「停」杀当前前台工具（${tool} 工具），不碰别的子进程`, { skip: IS_WIN && '要真 bash 子进程，只在 Linux / macOS 跑' }, async () => {
    const r = new Rig()
    let shell
    // 用测试进程充当 Claude Code：它的 sh 子进程就是工具进程
    try {
      await r.startDaemon()
      await r.bridge(process.pid)
      r.hook('PreToolUse', { tool_name: tool })
      await sleep(100)
      shell = spawn('bash', ['-c', 'sleep 300 & wait'], { stdio: 'ignore', detached: true })
      const gone = new Promise(res => shell.on('exit', res))
      r.add(msg('om_stop', 'ou_ok', { content: '停' }))
      await until(() => r.log().includes('已杀工具进程树'), '杀进程')
      assert.match(r.log(), /停（收到「停」）：丢 0 条，杀工具 true/)
      await gone
      assert.ok(r.daemon.exitCode === null, '常驻进程还活着')
    } finally {
      // 没杀成时别把 sleep 留下（整个进程组一起收）
      try { process.kill(-shell.pid, 'SIGKILL') } catch {}
      r.close()
    }
  })
}

test('排队中撤回只撤下；处理中撤回打断这一轮，同一轮忙时送达的照样要处理，不暂停定时', async () => {
  const r = new Rig()
  try {
    await r.startDaemon() // 先不接桥：离线时消息排队
    r.add(msg('om_q'))
    await until(() => r.file('reactions.txt').includes('om_q GLANCE'), '排队')
    r.messages[0].deleted = true
    r.write()
    await until(() => r.log().includes('排队中撤回 om_q'), '撤回')
    await until(() => r.file('sent.txt').includes('om_q 已从队列撤下'), '回执')
    await r.bridge()
    await sleep(200)
    assert.equal(r.pushes.length, 0)

    r.add(msg('om_d'))
    await until(() => r.pushes.length === 1, '送达')
    r.hook('UserPromptSubmit')
    await until(() => r.file('reactions.txt').includes('om_d OneSecond'), '处理中')
    r.add(msg('om_more'))
    await until(() => r.pushes.length === 2, '补充忙时送达')
    writeFileSync(join(r.dir, 'recall'), 'om_d')
    await until(() => r.file('sent.txt').includes('om_d 已撤回，正在处理它的这一轮已打断'), '打断回执')
    assert.match(r.hook('PreToolUse', { tool_name: 'Bash' }).stdout, /"permissionDecision":"deny"/)
    r.hook('Stop')
    await until(() => r.pushes.length === 3, '作废说明')
    assert.match(r.pushes[2].content, /om_d 已撤回、作废.*同一轮的 om_more 没有撤回，仍要处理/)
    assert.doesNotMatch(r.file('sent.txt'), /已停/)
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '没暂停' })
    await until(() => r.pushes.length === 4, '定时照常')
  } finally { r.close() }
})

test('忙时送达的消息撤回：按处理中打断这一轮', () => rig(async r => {
  r.hook('UserPromptSubmit')
  r.add(msg('om_b'))
  await until(() => r.pushes.length === 1, '忙时送达')
  writeFileSync(join(r.dir, 'recall'), 'om_b')
  await until(() => r.file('sent.txt').includes('om_b 已撤回，正在处理它的这一轮已打断'), '打断回执')
  assert.ok(existsSync(join(r.dir, 'cli_me.stop')))
  r.add(msg('om_after'))
  await until(() => r.file('reactions.txt').includes('om_after GLANCE'), '打断中到的排队')
  assert.equal(r.pushes.length, 1)
  r.hook('Stop')
  await until(() => r.pushes.length === 2, '闲后送说明和新消息')
  assert.match(r.pushes[1].content, /om_b 已撤回、作废[\s\S]*正文 om_after/)
}))

test('闲时撤回已处理完的消息：只作废，不打断、不暂停定时', () => rig(async r => {
  r.add(msg('om_done'))
  await until(() => r.pushes.length === 1, '送达')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  writeFileSync(join(r.dir, 'recall'), 'om_done')
  await until(() => r.file('sent.txt').includes('om_done 已作废'), '回执')
  await until(() => r.pushes.length === 2, '作废说明')
  assert.match(r.pushes[1].content, /那一轮已经结束/)
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '没暂停' })
  await until(() => r.pushes.length === 3, '定时照常')
}))

const event = (r, m, senderId) => writeFileSync(join(r.dir, 'event'), JSON.stringify({
  chat: 'oc_group', message: { ...m, sender: { id: senderId, sender_type: 'user' } },
}))

// 撤回轮询也对已送达的消息调 get，关掉才数得准 get.log
test('事件直入：发送者在白名单就用事件内容，不调 get，顺带补漏同会话漏掉的消息', () => rig(async r => {
  event(r, msg('om_ev'), 'ou_ok')
  await until(() => r.pushes.length === 1, '送达')
  assert.equal(r.pushes[0].content, '正文 om_ev')
  assert.equal(r.file('get.log'), '')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  r.messages.push(msg('om_noevent'))
  r.write()
  event(r, msg('om_ev2'), 'ou_ok')
  await until(() => r.pushes.length === 2, '第二条')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await until(() => r.pushes.map(p => p.content).join().includes('om_noevent'), '没事件的那条也补上')
}, { recallPollSec: 0 }))

// 撤回轮询也对已送达的消息调 get，关掉才数得准 get.log
test('事件发送者对不上白名单：按 get 到的发送者判，白名单外照样丢弃', () => rig(async r => {
  r.messages.push(msg('om_bad', 'ou_bad'))
  r.write()
  event(r, msg('om_bad'), 'ou_open_of_bad')
  await until(() => r.log().includes('丢弃 om_bad'), '丢弃')
  r.messages.push(msg('om_bot', 'cli_lead'))
  r.write()
  event(r, msg('om_bot'), 'ou_open_of_bot')
  await until(() => r.pushes.length === 1, '送达')
  assert.match(r.pushes[0].content, /om_bot/)
  assert.equal(r.file('get.log'), 'om_bad\nom_bot\n')
  assert.match(r.file('cli_me-seen.txt'), /om_bad/)
  await sleep(100)
  assert.equal(r.pushes.length, 1)
}, { recallPollSec: 0 }))

test('认过的发送者不再 get：白名单里的直接入队，白名单外的直接丢，常驻进程重启后还记得', async () => {
  const r = new Rig({ recallPollSec: 0 }) // 撤回轮询也调 get，关掉才数得准
  try {
    await r.startDaemon()
    await r.bridge()
    r.messages.push(msg('om_b1', 'cli_lead'))
    r.write()
    event(r, msg('om_b1'), 'ou_open_of_bot')
    await until(() => r.pushes.length === 1, '第一条走 get')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    r.messages.push(msg('om_x1', 'ou_bad'))
    r.write()
    event(r, msg('om_x1'), 'ou_open_of_bad')
    await until(() => r.log().includes('丢弃 om_x1'), '白名单外第一条走 get')
    r.daemon.kill('SIGKILL')
    await r.startDaemon()
    r.link.destroy()
    await until(() => r.log().split('长连接已连上').length > 2, '重启完成')
    await r.bridge()
    event(r, msg('om_b2'), 'ou_open_of_bot')
    await until(() => r.pushes.length === 2, '第二条直接入队')
    assert.equal(r.pushes[1].meta.sender_id, 'cli_lead')
    event(r, msg('om_x2'), 'ou_open_of_bad')
    await until(() => r.log().includes('丢弃 om_x2'), '白名单外第二条直接丢')
    assert.equal(r.file('get.log'), 'om_b1\nom_x1\n')
  } finally {
    r.close()
  }
})

test('事件发送者缺字段：get 拿到白名单外的不放行', () => rig(async r => {
  r.messages.push(msg('om_x', 'ou_bad'))
  r.write()
  event(r, msg('om_x'), undefined)
  await until(() => r.log().includes('丢弃 om_x'), '丢弃')
  assert.equal(r.pushes.length, 0)
}))

test('事件入队失败立即补拉；列表暂时没有时继续补拉到拿到', () => rig(async r => {
  writeFileSync(join(r.dir, 'get-fail'), '')
  event(r, msg('om_late', 'cli_lead'), 'ou_bot')
  await until(() => r.log().includes('事件入队失败 om_late'), '失败')
  await until(() => r.log().includes('列表里还没有 om_late，单独重拉这个会话'), '第一次补拉')
  assert.doesNotMatch(r.log(), /补漏失败/)
  r.messages.push(msg('om_late', 'cli_lead'))
  r.write()
  await until(() => r.pushes.length === 1, '补拉送达')
}, { retrySec: 0.05 }))

test('事件和补漏都见到同一条只送一次', () => rig(async r => {
  event(r, msg('om_twice'), 'ou_ok')
  await until(() => r.pushes.length === 1, '送达')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  r.add(msg('om_twice'))
  await until(() => r.log().includes('拉取结束'), '补漏')
  await sleep(100)
  assert.equal(r.pushes.length, 1)
}))

test('事件直入走同一套「停」', () => rig(async r => {
  r.hook('UserPromptSubmit')
  event(r, msg('om_stop', 'ou_ok', { content: '停' }), 'ou_ok')
  await until(() => r.file('sent.txt').includes('已停'), '回执')
}))

test('常驻进程被杀后重启：队列不丢、不重复', async () => {
  const r = new Rig()
  try {
    await r.startDaemon() // 不接桥：消息留在队列里
    r.add(msg('om_1'))
    await until(() => r.file('cli_me-state.json').includes('om_1'), '入队')
    r.daemon.kill('SIGKILL')
    r.messages.push(msg('om_2'))
    r.write()
    rmSync(join(r.dir, 'consume.log'))
    await r.startDaemon()
    await r.bridge(888888)
    await until(() => r.pushes.length >= 1, '恢复后送达')
    await sleep(300)
    assert.equal(r.pushes.map(p => p.meta.message_id).join(' '), 'om_1,om_2')
  } finally { r.close() }
})

test('状态卡片只发一次、置顶一次，状态变了才更新', () => rig(async r => {
  await until(() => r.file('card.txt').includes('pin'), '置顶')
  r.hook('UserPromptSubmit')
  await until(() => r.file('card.txt').includes('patch 忙'), '更新')
  const n = r.file('card.txt').split('\n').length
  r.hook('PostToolUse', { tool_name: 'Read' })
  await sleep(300)
  assert.equal(r.file('card.txt').split('\n').length, n)
  assert.equal(r.file('card.txt').match(/^send/gm).length, 1)
}))

test('真桥先于常驻进程启动：连接失败后重试，消息和 reply 走通', async () => {
  const r = new Rig()
  const got = []
  const client = new Client({ name: 't', version: '0' })
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }).passthrough(),
    n => got.push(n.params),
  )
  const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src', 'bridge.mjs')], env: r.env })
  try {
    await client.connect(transport)
    await until(() => r.log().includes('桥已连上'), '桥连上')
    r.add(msg('om_1'))
    await until(() => got.length === 1, '通知')
    assert.equal(got[0].meta.message_id, 'om_1')
    const res = await client.callTool({ name: 'reply', arguments: { chat_id: 'oc_group', text: 'hi' } })
    assert.match(res.content[0].text, /已发送/)
  } finally {
    await client.close()
    // 桥起的外层循环是分离进程：先杀它再杀常驻进程，免得又被拉起
    const m = /常驻进程启动 pid=(\d+)，外层循环 (\d+)/.exec(r.log())
    for (const pid of m ? [m[2], m[1]] : []) {
      try { process.kill(Number(pid), 'SIGKILL') } catch {}
    }
    r.close()
  }
})

test('事件触发的补漏失败后很快重试', () => rig(async r => {
  writeFileSync(join(r.dir, 'list-fail'), '')
  r.add(msg('om_1'))
  await until(() => r.log().includes('补漏失败'), '补漏失败')
  await until(() => r.pushes.length === 1, '重试后送达')
}, { retrySec: 0.1 }))

test('送出后会话没唤醒：退回队列重发，唤醒后不再重发', () => rig(async r => {
  r.add(msg('om_1'))
  await until(() => r.pushes.length === 1, '首次送出')
  await until(() => r.pushes.length === 2, '重发')
  assert.equal(r.pushes[1].meta.retry, '1')
  r.hook('UserPromptSubmit')
  await until(() => r.log().includes('已唤醒'), '唤醒')
  r.hook('Stop')
  await sleep(600)
  assert.equal(r.pushes.length, 2)
  await until(() => r.file('reactions.txt').includes('om_1 CheckMark'), '完成表情')
}, { wakeTimeoutSec: 0.1 }))

test('等用户回答（PreToolUse 后没有 Post）：心跳超时仍按忙，不判闲、不重发；消息忙时送出一次；Post 回来后照常超时判闲', () => rig(async r => {
  r.hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask1' }) // PreToolUse 自己标忙；前面再发一个 hook 时看门狗可能在两次之间判闲
  await until(() => r.log().includes('工具 AskUserQuestion 还没结束'), '心跳超时但仍按忙')
  r.add(msg('om_1'))
  await until(() => r.pushes.length === 1, '忙时送出')
  assert.equal(r.pushes[0].meta.retry, undefined)
  await sleep(800) // 心跳超时和唤醒超时都过了好几轮
  assert.equal(r.pushes.length, 1, '等用户回答期间不重发')
  assert.doesNotMatch(r.log(), /标闲：心跳超时|没有唤醒会话/)
  assert.equal(r.log().split('还没结束').length, 2, '仍按忙只记一次日志')
  r.hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask1' })
  await until(() => r.log().includes('标闲：心跳超时'), 'Post 回来后照常超时判闲')
}, { busyTimeoutSec: 0.1, wakeTimeoutSec: 0.1 }))

test('丢了 Post 的工具不会一直卡在忙：Stop、UserPromptSubmit 清掉没配对的 PreToolUse；超过 toolWaitMaxSec 也不再算', async () => {
  for (const [how, extra] of [['Stop', {}], ['UserPromptSubmit', {}], ['超时', { toolWaitMaxSec: 0.3 }]]) {
    const r = new Rig({ busyTimeoutSec: 0.1, ...extra })
    try {
      await r.startDaemon()
      await r.bridge()
      r.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'lost' })
      if (how === 'Stop') {
        r.hook('Stop')
        r.hook('PreToolUse', { tool_name: 'Read', tool_use_id: 'next' }) // 下一轮：配对的工具调用，只有清掉了 lost 才会超时判闲
        r.hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'next' })
      } else if (how === 'UserPromptSubmit') {
        r.hook('UserPromptSubmit')
        await until(() => r.log().includes('清掉 1 个没等到 PostToolUse 的工具 Read'), `${how} 清掉`)
      }
      await until(() => r.log().includes('标闲：心跳超时'), `${how}：心跳超时判闲`)
    } finally { r.close() }
  }
})

test('唤醒重发到上限停发：消息留在队列、日志和卡片报警；下一次 hook 恢复送出', () => rig(async r => {
  r.add(msg('om_1'))
  await until(() => r.log().includes('连续 3 次没唤醒，停止重发'), '到上限停发')
  assert.equal(r.pushes.length, 3)
  await until(() => r.file('card.txt').includes('会话一直没唤醒，已停止重发'), '卡片报警')
  r.add(msg('om_2'))
  await until(() => r.file('reactions.txt').includes('om_2 GLANCE'), '新消息排队')
  await sleep(500)
  assert.equal(r.pushes.length, 3, '停发后不再送')
  assert.match(r.file('cli_me-state.json'), /om_1/, '消息留在队列')
  r.hook('PreToolUse', { tool_name: 'Read' }) // 会话有动静：忙时送出
  await until(() => r.log().includes('恢复送出（排队 2 条）'), '恢复')
  await until(() => r.pushes.length === 4, '恢复后送出')
  assert.equal(r.pushes[3].meta.message_id, 'om_1,om_2')
  await until(() => !r.file('card.txt').split('\n').filter(Boolean).at(-1).includes('会话一直没唤醒'), '卡片报警撤下')
}, { wakeTimeoutSec: 0.05, wakeRetryMax: 3 }))

test('唤醒重发停发后闲时收到 hook（Stop）也恢复，按闲时送出等唤醒', () => rig(async r => {
  r.add(msg('om_1'))
  await until(() => r.log().includes('停止重发'), '到上限停发')
  r.hook('Stop')
  await until(() => r.pushes.length === 3, '恢复后闲时送出')
  assert.equal(r.pushes[2].meta.retry, undefined, '恢复后重新计数')
  r.hook('UserPromptSubmit')
  await until(() => r.log().split('已唤醒').length === 2, '唤醒')
}, { wakeTimeoutSec: 0.1, wakeRetryMax: 2 }))

test('撤回事件：排队中的不送，比轮询先生效', async () => {
  const r = new Rig({ recallPollSec: 0 })
  try {
    await r.startDaemon()
    r.add(msg('om_q'))
    await until(() => r.file('reactions.txt').includes('om_q GLANCE'), '排队')
    writeFileSync(join(r.dir, 'recall'), 'om_q')
    await until(() => r.log().includes('排队中撤回 om_q'), '撤回事件')
    await r.bridge()
    await sleep(200)
    assert.equal(r.pushes.length, 0)
  } finally { r.close() }
})

const tool = (r, action, args) => new Promise(resolve => {
  const c = connect(r.sock)
  createInterface({ input: c }).on('line', l => { resolve(JSON.parse(l)); c.destroy() })
  c.write(`${JSON.stringify({ t: 'schedule', id: 1, action, args })}\n`)
})

test('定时：闲时送达，一次性的触发后删除，卡片显示下一个', () => rig(async r => {
  const at = new Date(Date.now() + 400).toISOString()
  const add = await tool(r, 'add', { kind: 'once', at, text: '核对价格' })
  assert.ok(add.ok, add.text)
  await until(() => r.file('card.txt').includes('下一个定时'), '卡片')
  await until(() => r.pushes.length === 1, '到点送达')
  assert.match(r.pushes[0].content, /\[定时 s1\].*核对价格/)
  assert.equal((await tool(r, 'list')).text, '没有定时')
}))

test('定时：忙时进队列等闲，消息忙时照送、不和它合并；「停」能清', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 200).toISOString(), text: '提醒A' })
  await until(() => r.log().includes('定时 s1 触发'), '到点')
  r.add(msg('om_1'))
  await until(() => r.pushes.length === 1, '消息忙时送达')
  assert.equal(r.pushes[0].meta.message_id, 'om_1')
  assert.doesNotMatch(r.pushes[0].content, /提醒A/)
  r.hook('Stop')
  await until(() => r.pushes.length === 2, '定时闲后送达')
  assert.match(r.pushes[1].content, /\[定时 s1\].*提醒A/)
  r.hook('UserPromptSubmit')
  r.hook('Stop')

  r.hook('UserPromptSubmit')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 200).toISOString(), text: '提醒B' })
  await until(() => r.log().includes('定时 s2 触发'), '到点')
  r.add(msg('om_stop', 'ou_ok', { content: '停' }))
  await until(() => r.file('sent.txt').includes('已停，丢了 1 条（含定时 s2）'), '回执')
}))

test('定时：离线错过的上线补发并标原定时间；过宽限期只回报跳过；每天的排到下一天', async () => {
  const r = new Rig()
  try {
    const now = Date.now()
    writeFileSync(join(r.dir, 'cli_me-state.json'), JSON.stringify({
      nextScheduleId: 4,
      schedules: [
        { id: 's1', kind: 'once', text: '宽限内', nextAt: now - 30 * 60_000 },
        { id: 's2', kind: 'once', text: '过期了', graceMin: 60, nextAt: now - 5 * 3600_000 },
        { id: 's3', kind: 'daily', time: '09:00', text: '每天', graceMin: 1, nextAt: now - 3600_000 },
      ],
    }))
    await r.startDaemon()
    await sleep(200)
    assert.equal(r.pushes.length, 0)
    await r.bridge()
    await until(() => r.pushes.length === 1, '补发')
    assert.match(r.pushes[0].content, /定时 s1.*原定.*晚了 30 分钟/)
    await until(() => r.file('sent.txt').includes('定时 s2 原定'), '跳过回报')
    await until(() => r.file('sent.txt').includes('定时 s3 原定'), '每天的也跳过')
    const left = (await tool(r, 'list')).text
    assert.match(left, /^s3 daily/)
    assert.equal(left.split('\n').length, 1)
  } finally { r.close() }
})

test('定时：常驻进程重启后还在', async () => {
  const r = new Rig()
  try {
    await r.startDaemon()
    await r.bridge()
    await tool(r, 'add', { kind: 'daily', time: '09:00', text: '早报' })
    r.link.destroy()
    r.daemon.kill('SIGKILL')
    rmSync(join(r.dir, 'consume.log'))
    await r.startDaemon()
    await r.bridge(888888)
    assert.match((await tool(r, 'list')).text, /s1 daily/)
  } finally { r.close() }
})

test('定时入参校验', () => rig(async r => {
  assert.equal((await tool(r, 'add', { kind: 'daily', time: '25:00', text: 'x' })).ok, false)
  assert.equal((await tool(r, 'add', { kind: 'once', at: '2000-01-01T00:00:00Z', text: 'x' })).ok, false)
  assert.equal((await tool(r, 'add', { kind: 'once', at: '明早九点', text: 'x' })).ok, false)
  assert.equal((await tool(r, 'add', { kind: 'once', at: '2099-01-01 09:00' })).ok, false)
  assert.equal((await tool(r, 'add', { kind: 'weekly', time: '09:00', weekday: 8, text: 'x' })).ok, false)
  assert.equal((await tool(r, 'add', { kind: 'process', pid: 4194000, text: 'x' })).ok, false)
  assert.equal((await tool(r, 'remove', { id: 'nope' })).ok, false)
}))

test('定时：「停」后暂停，下一条新指令恢复并标明晚了多久', () => rig(async r => {
  r.add(msg('om_stop', 'ou_ok', { content: '停' }))
  await until(() => r.file('sent.txt').includes('定时已暂停'), '回执')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '暂停中' })
  await sleep(400)
  assert.equal(r.pushes.length, 0)
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await until(() => r.pushes.length === 1, '恢复后送达')
}))

test('定时：等进程结束，常驻进程重启不丢', async () => {
  const r = new Rig()
  const job = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  try {
    await r.startDaemon()
    await r.bridge()
    assert.ok((await tool(r, 'add', { kind: 'process', pid: job.pid, text: '打包结果' })).ok)
    r.link.destroy()
    r.daemon.kill('SIGKILL')
    rmSync(join(r.dir, 'consume.log'))
    await r.startDaemon()
    await r.bridge(888888)
    await sleep(200)
    assert.equal(r.pushes.length, 0)
    job.kill('SIGKILL')
    await until(() => r.pushes.length === 1, '进程结束后送达')
    assert.match(r.pushes[0].content, /已结束.*打包结果/)
  } finally { job.kill('SIGKILL'); r.close() }
})

test('定时：「停」的暂停不被撤回的作废说明解除', () => rig(async r => {
  r.add(msg('om_d'))
  await until(() => r.pushes.length === 1, '送达')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  r.add(msg('om_stop', 'ou_ok', { content: '停' }))
  await until(() => r.file('sent.txt').includes('已停'), '停')
  writeFileSync(join(r.dir, 'recall'), 'om_d')
  await until(() => r.pushes.length === 2, '作废说明')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '暂停中' })
  await sleep(400)
  assert.equal(r.pushes.length, 2)
  r.add(msg('om_new'))
  await until(() => r.pushes.length === 3, '新指令')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await until(() => r.pushes.length === 4, '恢复后补发')
  assert.match(r.pushes[3].content, /暂停中/)
}))

const scoped = (r, list) => writeFileSync(join(r.dir, 'scopes.json'), JSON.stringify(list))

test('自检：核心权限缺失时退出码 78，不连长连接', async () => {
  const r = new Rig()
  try {
    scoped(r, ['im:chat'])
    r.daemon = spawn('node', [join(ROOT, 'src', 'daemon.mjs')], { env: r.env, stdio: 'ignore' })
    const code = await new Promise(res => r.daemon.on('exit', res))
    assert.equal(code, 78)
    assert.match(r.log(), /缺权限.*影响：/)
    assert.equal(r.file('consume.log'), '')
  } finally { r.close() }
})

test('自检：非核心权限缺失照常启动，卡片提示；查询失败不挡启动', async () => {
  const r = new Rig()
  try {
    scoped(r, ['im:chat', 'im:message:readonly', 'im:message:send_as_bot', 'im:message.group_msg', 'im:message.p2p_msg:readonly'])
    await r.startDaemon()
    await until(() => r.log().includes('im:message.reactions:write_only 或 im:message，影响：'), '缺表情权限')
    await r.bridge()
    await until(() => r.file('card.txt').includes('send') || r.file('card.txt').includes('patch'), '卡片')
  } finally { r.close() }
  const q = new Rig()
  try {
    writeFileSync(join(q.dir, 'scopes-fail'), '')
    await q.startDaemon()
    await until(() => q.log().includes('权限查询失败'), '查询失败')
    assert.ok(q.file('consume.log'))
  } finally { q.close() }
})

test('轮询发现撤回而事件没来：提示一次；事件来了不提示', () => rig(async r => {
  await sleep(500) // 过启动空档
  r.add(msg('om_a'))
  await until(() => r.pushes.length === 1, '送达')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  r.messages[0].deleted = true
  r.write()
  await until(() => r.log().includes('撤回事件可能没订阅'), '提示')
  await until(() => r.pushes.length === 2, '作废说明')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  r.add(msg('om_b'))
  await until(() => r.pushes.length === 3, '送达')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  const b = r.messages.find(m => m.message_id === 'om_b')
  b.deleted = true
  r.write()
  await until(() => r.pushes.length === 4, '第二次撤回')
  await sleep(300)
  assert.equal(r.log().match(/撤回事件可能没订阅/g).length, 1)
}, { recallPollSec: 0.1, recallHintSec: 0.05 }))

test('首次运行：只有第一轮全量补漏把现有消息当旧的；之后到的消息补漏照常送出，跳过的写日志', async () => {
  const r = new Rig({ sweepSec: 0.3 })
  rmSync(join(r.dir, 'cli_me-seen.txt')) // 没有已读记录 = 首次运行
  r.messages.push(msg('om_before'))
  r.write()
  try {
    await r.startDaemon()
    await r.bridge()
    await until(() => r.log().includes('首次运行：现有消息已记为已读'), '第一轮补完')
    assert.match(r.log(), /跳过 oc_group 的 1 条旧消息（首次运行，现有消息记为已读）：om_before/)
    // 事件不带内容（推送不通、只能靠补漏时的样子）：补这个会话
    r.add(msg('om_after_event'))
    await until(() => r.pushes.length === 1, '第一轮之后的消息由补漏送出')
    assert.equal(r.pushes[0].meta.message_id, 'om_after_event')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    // 没有事件，只靠定时全量补漏
    r.messages.push(msg('om_after_sweep'))
    r.write()
    await until(() => r.pushes.length === 2, '定时全量补漏送出')
    assert.equal(r.pushes[1].meta.message_id, 'om_after_sweep')
    assert.ok(!r.pushes.some(p => p.meta.message_id.includes('om_before')), '首次运行前的旧消息不送')
  } finally { r.close() }
})

// ---------- 只送达（observe）的外部发送者 ----------

const OBSERVE = { observe: { chats: ['oc_group'] } }
const stranger = (id, sender, name, extra = {}) => msg(id, sender, { sender: { id: sender, name, sender_type: 'user' }, ...extra })

test('只送达：observe 的群里白名单外的人照送，标 trust=external、带 open_id 和名字，不和白名单消息合并；表情照旧', async () => {
  const r = new Rig(OBSERVE)
  try {
    await r.startDaemon() // 先不接桥：几条一起排队，看怎么合并
    r.add(msg('om_a'), stranger('om_t1', 'ou_t1', '测试甲'), stranger('om_t2', 'ou_t2', ''), msg('om_b'))
    await until(() => r.file('reactions.txt').includes('om_t2 GLANCE'), '外部发送者的消息排队')
    await r.bridge()
    await until(() => r.pushes.length === 1, '先送白名单的')
    assert.equal(r.pushes[0].meta.message_id, 'om_a,om_b')
    assert.equal(r.pushes[0].meta.trust, undefined)
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    await until(() => r.pushes.length === 2, '再送外部发送者的')
    const p = r.pushes[1]
    assert.equal(p.meta.message_id, 'om_t1,om_t2')
    assert.equal(p.meta.trust, 'external')
    assert.equal(p.meta.sender_id, 'ou_t1')
    assert.equal(p.meta.sender_name, '测试甲')
    assert.match(p.content, /\[om_t1 测试甲 ou_t1 [^\]]*\]\n正文 om_t1/)
    assert.match(p.content, /\[om_t2 ou_t2 [^\]]*\]\n正文 om_t2/, '没名字时只写 open_id')
    await until(() => r.file('reactions.txt').includes('om_t1 OneSecond'), '处理中表情')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    await until(() => r.file('reactions.txt').includes('om_t2 CheckMark'), '完成表情')
  } finally { r.close() }
}, OBSERVE)

test('只送达：事件来的外部发送者按 open_id 查名字，查过的不再查；没列进 observe 的会话照丢', () => rig(async r => {
  writeFileSync(join(r.dir, 'names.json'), JSON.stringify({ ou_t3: '测试丙' }))
  r.messages.push(stranger('om_t3', 'ou_t3', '')) // get 不带名字
  r.write()
  event(r, r.messages[0], 'ou_t3')
  await until(() => r.pushes.length === 1, '送达')
  assert.equal(r.pushes[0].meta.trust, 'external')
  assert.equal(r.pushes[0].meta.sender_id, 'ou_t3')
  assert.equal(r.pushes[0].meta.sender_name, '测试丙')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  r.messages.push(stranger('om_t4', 'ou_t3', ''))
  r.write()
  event(r, r.messages[1], 'ou_t3')
  await until(() => r.pushes.length === 2, '第二条送达')
  assert.equal(r.pushes[1].meta.sender_name, '测试丙')
  assert.equal(r.file('names.log'), 'ou_t3\n', '名字只查一次')
  assert.equal(r.file('get.log'), 'om_t3\n', '认过的发送者不再 get')
  // 私信没开 dms：白名单外的照丢
  r.messages.push({ ...stranger('om_dm', 'ou_t5', ''), chat_id: 'oc_dm' })
  r.write()
  writeFileSync(join(r.dir, 'event'), JSON.stringify({ chat: 'oc_dm', chatType: 'p2p', message: { ...r.messages[2], sender: { id: 'ou_t5', sender_type: 'user' } } }))
  await until(() => r.log().includes('丢弃 om_dm'), '没开 dms 的私信丢弃')
}, { ...OBSERVE, recallPollSec: 0 }))

test('只送达：dms 打开时私信里白名单外的人照送；查不到名字就只带 open_id', () => rig(async r => {
  r.messages.push({ ...stranger('om_dm', 'ou_t6', ''), chat_id: 'oc_dm' })
  r.write()
  writeFileSync(join(r.dir, 'event'), JSON.stringify({ chat: 'oc_dm', chatType: 'p2p', message: { ...r.messages[0], sender: { id: 'ou_t6', sender_type: 'user' } } }))
  await until(() => r.pushes.length === 1, '私信送达')
  assert.equal(r.pushes[0].meta.chat_type, 'p2p')
  assert.equal(r.pushes[0].meta.trust, 'external')
  assert.equal(r.pushes[0].meta.sender_name, 'ou_t6')
  assert.match(r.log(), /查不到 ou_t6 的名字/)
}, { observe: { dms: true }, recallPollSec: 0 }))

test('只送达：不授权——「停」当普通消息忙时送达，不杀不拦；送出后撤回只补发作废说明（忙时也送），不打断这一轮', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await until(() => r.log().includes('标忙'), '标忙')
  r.hook('PreToolUse', { tool_name: 'Bash' })
  r.add(msg('om_ok'), stranger('om_ts', 'ou_t1', '测试甲', { content: '停' }))
  await until(() => r.pushes.length === 2, '白名单的和外部的忙时都送，各成一批')
  assert.equal(r.pushes[0].meta.message_id, 'om_ok')
  assert.equal(r.pushes[0].meta.trust, undefined)
  assert.equal(r.pushes[1].content, '停')
  assert.equal(r.pushes[1].meta.trust, 'external')
  await until(() => r.log().includes('忙时送出 1 条：om_ts'), '外部的忙时送出')
  assert.ok(!existsSync(join(r.dir, 'cli_me.stop')), '外部发送者的「停」不写停止标记')
  assert.doesNotMatch(r.log(), /停（|已杀工具/)
  assert.doesNotMatch(r.file('sent.txt'), /已停/)
  await until(() => r.file('reactions.txt').includes('om_ts OneSecond'), '处理中表情')
  writeFileSync(join(r.dir, 'recall'), 'om_ts')
  await until(() => r.pushes.length === 3, '作废说明忙时送达')
  assert.match(r.pushes[2].content, /om_ts（外部发送者）已撤回，内容作废/)
  assert.ok(!existsSync(join(r.dir, 'cli_me.stop')), '不打断这一轮')
  assert.doesNotMatch(r.file('sent.txt'), /已打断/)
  assert.equal(r.hook('PreToolUse', { tool_name: 'Bash' }).stdout, '', '工具照常放行')
  // 排队中的撤回：从队列撤下（会话离线时排队）
  r.link.destroy()
  await until(() => r.log().includes('桥断开'), '离线')
  r.add(stranger('om_tq', 'ou_t1', '测试甲'))
  await until(() => r.file('reactions.txt').includes('om_tq GLANCE'), '排队')
  writeFileSync(join(r.dir, 'recall'), 'om_tq')
  await until(() => r.file('sent.txt').includes('om_tq 已从队列撤下'), '撤下')
  r.hook('Stop')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  assert.equal(r.pushes.length, 3)
}, OBSERVE))

test('只送达：外部发送者的消息不解除「停」暂停的定时，白名单的新指令才解除', () => rig(async r => {
  r.add(msg('om_stop', 'ou_ok', { content: '停' }))
  await until(() => r.file('sent.txt').includes('定时已暂停'), '停')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 100).toISOString(), text: '暂停中' })
  r.add(stranger('om_t1', 'ou_t1', '测试甲'))
  await until(() => r.pushes.length === 1, '外部发送者的闲时送达')
  r.hook('UserPromptSubmit')
  r.add(stranger('om_t2', 'ou_t1', '测试甲'))
  await until(() => r.log().includes('忙时送出 1 条：om_t2'), '外部发送者的忙时送达')
  r.hook('UserPromptSubmit') // 忙时送进去的那条进会话
  r.hook('Stop')
  await sleep(400)
  assert.equal(r.pushes.length, 2, '定时还暂停着')
  assert.match((await tool(r, 'list')).text, /定时已暂停/)
  r.add(msg('om_new'))
  await until(() => r.pushes.length === 3, '新指令')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await until(() => r.pushes.length === 4, '恢复后补发')
  assert.match(r.pushes[3].content, /暂停中/)
}, OBSERVE))

const strangerEvent = (r, m, chat, chatType) => writeFileSync(join(r.dir, 'event'), JSON.stringify({ chat, chatType, message: { ...m, sender: { id: m.sender.id, sender_type: 'user' } } }))

test('只送达：observe=true 时没列出的群和私信里白名单外的人都照送', () => rig(async r => {
  r.messages.push({ ...stranger('om_g', 'ou_t7', '测试丁'), chat_id: 'oc_other' }, { ...stranger('om_p', 'ou_t8', '测试戊'), chat_id: 'oc_dm' })
  r.write()
  strangerEvent(r, r.messages[0], 'oc_other', 'group')
  await until(() => r.pushes.length === 1, '没列出的群送达')
  assert.equal(r.pushes[0].meta.chat_id, 'oc_other')
  assert.equal(r.pushes[0].meta.trust, 'external')
  r.hook('UserPromptSubmit')
  strangerEvent(r, r.messages[1], 'oc_dm', 'p2p')
  await until(() => r.pushes.length === 2, '私信忙时送达')
  assert.equal(r.pushes[1].meta.chat_type, 'p2p')
  assert.equal(r.pushes[1].meta.trust, 'external')
  assert.doesNotMatch(r.log(), /丢弃/)
}, { observe: true, recallPollSec: 0 }))

test('只送达：没配 observe 时群里和私信里白名单外的照丢', () => rig(async r => {
  r.messages.push({ ...stranger('om_g', 'ou_t7', '测试丁'), chat_id: 'oc_other' }, { ...stranger('om_p', 'ou_t8', '测试戊'), chat_id: 'oc_dm' })
  r.write()
  strangerEvent(r, r.messages[0], 'oc_other', 'group')
  await until(() => r.log().includes('丢弃 om_g'), '群里丢弃')
  strangerEvent(r, r.messages[1], 'oc_dm', 'p2p')
  await until(() => r.log().includes('丢弃 om_p'), '私信丢弃')
  r.add(stranger('om_x', 'ou_t9', '测试己'))
  await until(() => r.log().includes('丢弃 om_x'), '补漏路径丢弃')
  await sleep(200)
  assert.equal(r.pushes.length, 0)
}, { recallPollSec: 0 }))
