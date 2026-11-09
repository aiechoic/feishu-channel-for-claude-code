// 桥的工具转发：常驻进程换版后已开的 MCP 会话拿到新工具；新桥连旧常驻进程、旧桥连新常驻进程都照常能用
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { paths } from '../src/common.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OLD_TOOLS = ['read_unread', 'reply', 'schedule_add', 'schedule_list', 'schedule_remove']

async function until(cond, what, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await cond()) return
  throw new Error(`等不到：${what}`)
}

class Rig {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'feishu-bridge-'))
    writeFileSync(join(this.dir, 'messages.json'), '[]')
    this.cfg = join(this.dir, 'config.json')
    writeFileSync(this.cfg, JSON.stringify({ appId: 'cli_me', appSecret: 'x', allow: ['ou_ok'], stateDir: this.dir, sweepSec: 0, recallPollSec: 0, statusChat: 'oc_group' }))
    this.env = {
      ...process.env, FEISHU_CHANNEL_CONFIG: this.cfg, FEISHU_ADAPTER: join(HERE, 'fake-feishu.mjs'), FAKE: this.dir,
      FEISHU_BRIDGE_TOOLS_TIMEOUT_MS: '500', FEISHU_TEST_PROCESS_DIR: this.dir,
      // 桥不许自己起外层循环：常驻进程由测试起、测试杀
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(join(HERE, 'owned-daemon.mjs')).href}`,
    }
    this.sock = paths({ appId: 'cli_me', stateDir: this.dir }).sock
    this.clients = []
  }

  log() { const f = join(this.dir, 'cli_me.log'); return existsSync(f) ? readFileSync(f, 'utf8') : '' }

  /** 起常驻进程；src 给另一份源码目录就是「换了版」 */
  async startDaemon(src = join(ROOT, 'src')) {
    const n = this.log().split('常驻进程启动').length
    this.daemon = spawn(process.execPath, [join(src, 'daemon.mjs')], { env: this.env, stdio: 'ignore' })
    await until(() => this.log().split('常驻进程启动').length > n, '常驻进程启动')
  }

  async stopDaemon() {
    const d = this.daemon
    if (!d || d.exitCode !== null) return
    const gone = new Promise(r => d.once('exit', r))
    d.kill('SIGKILL')
    await gone
  }

  /** MCP 客户端连一个桥；changed 记收到的 list_changed */
  async client(bridge = join(ROOT, 'src', 'bridge.mjs'), env = {}) {
    const c = new Client({ name: 't', version: '0' })
    c.changed = 0
    c.setNotificationHandler(ToolListChangedNotificationSchema, () => { c.changed++ })
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [bridge], env: { ...this.env, ...env } }))
    this.clients.push(c)
    return c
  }

  async close() {
    for (const c of this.clients) await c.close().catch(() => {})
    await this.stopDaemon()
    this.fake?.close()
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

const names = async c => (await c.listTools()).tools.map(t => t.name).sort()
const textOf = r => r.content[0].text

test('常驻进程换版：桥重连后发 list_changed，重新 tools/list 看得到新工具，调用转到新常驻进程', async () => {
  const r = new Rig()
  // 「新版」：一份源码副本，工具里多一个 ping（放在仓库里，依赖照常解析）
  const v2 = mkdtempSync(join(ROOT, 'test', '.v2-'))
  try {
    cpSync(join(ROOT, 'src'), v2, { recursive: true })
    writeFileSync(join(v2, 'tools.mjs'), readFileSync(join(v2, 'tools.mjs'), 'utf8')
      .replace("}]\n\nconst text", "}, {\n  name: 'ping',\n  description: '新版才有',\n  inputSchema: { type: 'object', properties: {} },\n}]\n\nconst text")
      .replace("    return text(`未知工具", "    if (name === 'ping') return text('pong')\n    return text(`未知工具"))
    await r.startDaemon()
    const claude = await r.client()
    const codex = await r.client(undefined, { FEISHU_CODEX_TOOLS_ONLY: '1' })
    for (const c of [claude, codex]) assert.deepEqual(await names(c), OLD_TOOLS)
    assert.match(textOf(await claude.callTool({ name: 'read_unread', arguments: { chat_id: 'oc_group' } })), /没有未读/)

    await r.stopDaemon()
    await r.startDaemon(v2)
    for (const c of [claude, codex]) await until(() => c.changed === 1, 'list_changed')
    for (const c of [claude, codex]) {
      assert.deepEqual(await names(c), [...OLD_TOOLS, 'ping'].sort())
      assert.equal(textOf(await c.callTool({ name: 'ping', arguments: {} })), 'pong')
      assert.ok((await c.callTool({ name: 'reply', arguments: { chat_id: 'bad', text: 'x' } })).isError, '参数校验在常驻进程')
    }

    // 再换回去：ping 没了，再通知一次；同版重启不通知
    await r.stopDaemon()
    await r.startDaemon()
    await until(() => claude.changed === 2, '第二次 list_changed')
    assert.deepEqual(await names(claude), OLD_TOOLS)
    assert.match(textOf(await claude.callTool({ name: 'ping', arguments: {} })), /未知工具/)
    await r.stopDaemon()
    await r.startDaemon()
    await until(() => r.log().split('桥已连上').length >= 5, '同版重启后桥连上')
    await sleep(700)
    assert.equal(claude.changed, 2, '列表没变不通知')
  } finally {
    await r.close()
    rmSync(v2, { recursive: true, force: true })
  }
})

test('新桥连旧版常驻进程（不认识 tools / call）：不卡住，给原来那 5 个工具，按旧消息格式调用', async () => {
  const r = new Rig()
  const seen = []
  // 只认 hello / reply / schedule / unread 的旧常驻进程，别的消息不答
  r.fake = createServer(s => createInterface({ input: s }).on('line', l => {
    const m = JSON.parse(l)
    seen.push(m.t)
    if (m.t === 'reply') s.write(`${JSON.stringify({ t: 'reply-result', id: m.id, ok: true, text: `已发送 om_${m.text}` })}\n`)
    if (m.t === 'unread') s.write(`${JSON.stringify({ t: 'reply-result', id: m.id, ok: true, text: `会话 ${m.args.chat_id} 没有未读` })}\n`)
    if (m.t === 'schedule') s.write(`${JSON.stringify({ t: 'reply-result', id: m.id, ok: true, text: `schedule ${m.action}` })}\n`)
  })).listen(r.sock)
  try {
    const c = await r.client()
    const t0 = Date.now()
    assert.deepEqual(await names(c), OLD_TOOLS)
    assert.ok(Date.now() - t0 < 4000, '旧常驻进程不答 tools 也很快给出列表')
    assert.equal(textOf(await c.callTool({ name: 'reply', arguments: { chat_id: 'oc_group', text: 'hi' } })), '已发送 om_hi')
    assert.match(textOf(await c.callTool({ name: 'read_unread', arguments: { chat_id: 'oc_group' } })), /没有未读/)
    assert.equal(textOf(await c.callTool({ name: 'schedule_list', arguments: {} })), 'schedule list')
    assert.ok((await c.callTool({ name: 'reply', arguments: { chat_id: 'bad', text: 'x' } })).isError)
    assert.ok(!seen.includes('call'), '旧常驻进程不发 call')
    assert.equal(c.changed, 0)
  } finally {
    await r.close()
  }
})

test('旧桥（d293cb4，工具写死）连新常驻进程：原来那 5 个工具照常能用', async () => {
  const r = new Rig()
  try {
    await r.startDaemon()
    const c = await r.client(join(HERE, 'fixtures', 'bridge-d293cb4.mjs'))
    assert.deepEqual(await names(c), OLD_TOOLS)
    await until(() => r.log().includes('桥已连上'), '旧桥连上')
    assert.match(textOf(await c.callTool({ name: 'reply', arguments: { chat_id: 'oc_group', text: 'hi' } })), /^已发送/)
    assert.match(textOf(await c.callTool({ name: 'read_unread', arguments: { chat_id: 'oc_group' } })), /没有未读/)
    const add = await c.callTool({ name: 'schedule_add', arguments: { kind: 'daily', time: '09:00', text: '看日报' } })
    assert.ok(!add.isError, textOf(add))
    const list = textOf(await c.callTool({ name: 'schedule_list', arguments: {} }))
    assert.match(list, /看日报/)
    const id = list.split(' ')[0]
    assert.match(textOf(await c.callTool({ name: 'schedule_remove', arguments: { id } })), /已删定时/)
    assert.ok((await c.callTool({ name: 'schedule_remove', arguments: { id } })).isError, '错误照旧带 isError')
  } finally {
    await r.close()
  }
})
