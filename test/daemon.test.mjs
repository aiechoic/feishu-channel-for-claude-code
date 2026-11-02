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

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

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
    await until(() => existsSync(join(this.dir, 'cli_me.sock')), 'socket')
    const c = connect(join(this.dir, 'cli_me.sock'))
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
    rmSync(this.dir, { recursive: true, force: true })
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
  assert.match(r.log(), /丢弃 om_x/)
  await until(() => r.file('reactions.txt').includes('om_1 OneSecond'), '处理中表情')
  r.hook('UserPromptSubmit')
  r.hook('Stop')
  await until(() => r.file('reactions.txt').includes('om_1 CheckMark'), '完成表情')
}))

test('忙时只进队列，Stop 后合并成一条', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await until(() => r.log().includes('标忙'), '标忙')
  r.add(msg('om_1'), msg('om_2'))
  await until(() => r.file('reactions.txt').includes('om_2 GLANCE'), '排队表情')
  r.add(msg('om_3'))
  await until(() => r.file('reactions.txt').includes('om_3 GLANCE'), '排队表情')
  assert.equal(r.pushes.length, 0)
  r.hook('Stop')
  await until(() => r.pushes.length === 1, '合并送达')
  assert.equal(r.pushes[0].meta.message_id, 'om_1,om_2,om_3')
  assert.equal(r.pushes[0].meta.merged, '3')
  assert.match(r.pushes[0].content, /正文 om_1[\s\S]*正文 om_3/)
}))

test('忙但心跳超时按闲处理并送出排队消息', () => rig(async r => {
  r.hook('UserPromptSubmit')
  r.add(msg('om_1'))
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

test('「停」：清空队列、写标记、拦工具、回执；句子里带停字不触发', () => rig(async r => {
  r.hook('UserPromptSubmit')
  r.add(msg('om_1'), msg('om_no', 'ou_ok', { content: '先别停' }))
  await until(() => r.file('reactions.txt').includes('om_no GLANCE'), '排队')
  r.add(msg('om_bad', 'ou_bad', { content: '停' }))
  await until(() => r.log().includes('丢弃 om_bad'), '白名单外的停被丢弃')
  assert.ok(!existsSync(join(r.dir, 'cli_me.stop')))
  r.add(msg('om_stop', 'ou_ok', { content: '停' }))
  await until(() => existsSync(join(r.dir, 'cli_me.stop')), '停止标记')
  await until(() => r.file('sent.txt').includes('已停，丢了 2 条'), '回执')
  const out = r.hook('PreToolUse', { tool_name: 'Bash' })
  assert.equal(JSON.parse(out.stdout).continue, false)
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny')
  r.hook('Stop')
  await until(() => !existsSync(join(r.dir, 'cli_me.stop')), '标记清掉')
  r.add(msg('om_new'))
  await until(() => r.pushes.length === 1, '新指令送达')
  assert.equal(r.pushes[0].meta.message_id, 'om_new')
}))

test('「停」杀当前前台工具，不碰别的子进程', async () => {
  const r = new Rig()
  // 用测试进程充当 Claude Code：它的 sh 子进程就是工具进程
  try {
    await r.startDaemon()
    await r.bridge(process.pid)
    r.hook('PreToolUse', { tool_name: 'Bash' })
    await sleep(100)
    const shell = spawn('bash', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' })
    const gone = new Promise(res => shell.on('exit', res))
    r.add(msg('om_stop', 'ou_ok', { content: '停' }))
    await until(() => r.log().includes('已杀工具进程树'), '杀进程')
    await gone
    assert.ok(r.daemon.exitCode === null, '常驻进程还活着')
  } finally { r.close() }
})

test('排队中撤回不送；送达后撤回自动停并发作废说明', () => rig(async r => {
  r.hook('UserPromptSubmit')
  r.add(msg('om_q'))
  await until(() => r.file('reactions.txt').includes('om_q GLANCE'), '排队')
  r.messages[0].deleted = true
  r.write()
  await until(() => r.log().includes('排队中撤回 om_q'), '撤回')
  r.hook('Stop')
  await sleep(200)
  assert.equal(r.pushes.length, 0)

  r.add(msg('om_d'))
  await until(() => r.pushes.length === 1, '送达')
  await until(() => r.file('reactions.txt').includes('om_d OneSecond'), '处理中')
  r.messages[1].deleted = true
  r.write()
  await until(() => r.file('sent.txt').includes('已停'), '自动停')
  r.hook('Stop')
  await until(() => r.pushes.length === 2, '作废说明')
  assert.match(r.pushes[1].content, /om_d 已撤回、作废/)
}))

test('常驻进程被杀后重启：队列不丢、不重复', async () => {
  const r = new Rig()
  try {
    await r.startDaemon()
    await r.bridge()
    r.hook('UserPromptSubmit')
    r.add(msg('om_1'))
    await until(() => r.file('cli_me-state.json').includes('om_1'), '入队')
    r.link.destroy()
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
    spawnSync('pkill', ['-f', r.dir]) // 外层循环：命令行里有本次临时目录
    const pid = /常驻进程启动 pid=(\d+)/.exec(r.log())?.[1]
    if (pid) process.kill(Number(pid), 'SIGKILL')
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

test('撤回事件：排队中的不送，比轮询先生效', () => rig(async r => {
  r.hook('UserPromptSubmit')
  r.add(msg('om_q'))
  await until(() => r.file('reactions.txt').includes('om_q GLANCE'), '排队')
  writeFileSync(join(r.dir, 'recall'), 'om_q')
  await until(() => r.log().includes('排队中撤回 om_q'), '撤回事件')
}, { recallPollSec: 0 }))

const tool = (r, action, args) => new Promise(resolve => {
  const c = connect(join(r.dir, 'cli_me.sock'))
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

test('定时：忙时进队列和消息合并，「停」能清', () => rig(async r => {
  r.hook('UserPromptSubmit')
  await tool(r, 'add', { kind: 'once', at: new Date(Date.now() + 200).toISOString(), text: '提醒A' })
  await until(() => r.log().includes('定时 s1 触发'), '到点')
  r.add(msg('om_1'))
  await until(() => r.file('reactions.txt').includes('om_1 GLANCE'), '排队')
  r.hook('Stop')
  await until(() => r.pushes.length === 1, '合并')
  assert.equal(r.pushes[0].meta.merged, '2')
  assert.match(r.pushes[0].content, /\[定时 s1[\s\S]*提醒A[\s\S]*正文 om_1/)

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
  const job = spawn('sleep', ['30'], { stdio: 'ignore' })
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

test('定时：送达后撤回的作废说明不解除暂停', () => rig(async r => {
  r.add(msg('om_d'))
  await until(() => r.pushes.length === 1, '送达')
  r.hook('UserPromptSubmit')
  writeFileSync(join(r.dir, 'recall'), 'om_d')
  await until(() => r.file('sent.txt').includes('已停'), '自动停')
  r.hook('Stop')
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
