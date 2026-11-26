// 企业微信 channel 整条链路：真常驻进程 + 真适配器 + 真 SDK，连本地假服务；假桥接在本机端点上收推送、调工具
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
import { paths } from '../src/common.mjs'
import { startFake, textMsg } from './fake-wecom-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(50)
  }
  assert.fail(`超时：${what}`)
}

class Rig {
  constructor(fake, extra = {}, dir = mkdtempSync(join(tmpdir(), 'wecom-channel-'))) {
    this.fake = fake
    this.dir = dir
    writeFileSync(join(dir, 'bot-secret'), 'secret_example')
    this.conf = { platform: 'wecom', botId: 'bot_example', botSecretFile: join(dir, 'bot-secret'), allow: ['alice'], stateDir: dir, wsUrl: fake.url, reconnectBaseMs: 20, ...extra }
    this.cfg = join(dir, 'wecom-config.json')
    writeFileSync(this.cfg, JSON.stringify(this.conf))
    const env = { ...process.env, FEISHU_CHANNEL_CONFIG: this.cfg }
    delete env.FEISHU_ADAPTER
    delete env.CHANNEL_ADAPTER
    this.env = env
    this.P = paths(this.conf)
    this.pushes = []
    this.results = new Map()
    this.nextId = 1
  }

  log() { return existsSync(this.P.log) ? readFileSync(this.P.log, 'utf8') : '' }

  async start() {
    this.daemon = spawn(process.execPath, [join(ROOT, 'src', 'daemon.mjs')], { env: this.env, stdio: 'ignore' })
    await until(() => this.log().includes('常驻进程启动'), '常驻进程启动')
  }

  async bridge(claudePid = 999999) {
    const c = connect(this.P.sock)
    createInterface({ input: c }).on('line', l => {
      const m = JSON.parse(l)
      if (m.t === 'push') {
        this.pushes.push(m)
        c.write(`${JSON.stringify({ t: 'ack', pushId: m.pushId })}\n`)
      } else if (m.id) this.results.set(m.id, m)
    })
    c.write(`${JSON.stringify({ t: 'hello', claudePid, bridgePid: 1 })}\n`)
    this.link = c
    await until(() => this.log().includes('桥已连上'), '桥连上')
  }

  /** 像桥那样调工具，返回 call-result / tools-result */
  async ask(body) {
    const id = this.nextId++
    this.link.write(`${JSON.stringify({ ...body, id })}\n`)
    await until(() => this.results.has(id), `回应 ${body.t}`)
    return this.results.get(id)
  }

  call(name, args) { return this.ask({ t: 'call', name, args }).then(r => r.result) }

  /** 会话处理完这一轮（Stop hook），下一批才会闲时送出 */
  idle() {
    spawnSync(process.execPath, [join(ROOT, 'src', 'hook.mjs'), this.cfg], { input: JSON.stringify({ hook_event_name: 'Stop' }), encoding: 'utf8' })
  }

  async stop() {
    this.link?.destroy()
    if (this.daemon && this.daemon.exitCode === null) {
      const gone = new Promise(r => this.daemon.once('exit', r))
      this.daemon.kill('SIGKILL')
      await gone
    }
  }

  async close() {
    await this.stop()
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

async function withRig(extra, fn) {
  const fake = await startFake()
  const r = new Rig(fake, extra)
  try {
    await r.start()
    await r.bridge()
    await until(() => fake.authed === 1, '长连接认证')
    await fn(r, fake)
  } finally {
    await r.close()
    fake.close()
  }
}

test('企业微信 channel：白名单里的 userid 发的单聊送进会话，reply 走主动推送；工具里没有 read_unread', () => withRig({}, async (r, fake) => {
  fake.push(textMsg('m1', 'alice', '这周的反馈'))
  await until(() => r.pushes.length === 1, '送达')
  const { meta, content } = r.pushes[0]
  assert.equal(content, '这周的反馈')
  assert.equal(meta.chat_id, 'alice')
  assert.equal(meta.chat_type, 'p2p')
  assert.equal(meta.sender_id, 'alice')
  assert.equal(meta.message_id, 'm1')
  assert.equal(meta.trust, undefined, '白名单内不标 external')
  const ok = await r.call('reply', { chat_id: 'alice', text: '收到' })
  assert.ok(!ok.isError, ok.content[0].text)
  assert.deepEqual(fake.sent.at(-1), { chatid: 'alice', msgtype: 'markdown', markdown: { content: '收到' } })
  const bad = await r.call('reply', { chat_id: 'a b', text: 'x' })
  assert.ok(bad.isError)
  assert.match(bad.content[0].text, /userid/)
  const { tools } = await r.ask({ t: 'tools' })
  assert.deepEqual(tools.map(t => t.name), ['reply', 'schedule_add', 'schedule_list', 'schedule_remove'])
  assert.match(tools[0].description, /企业微信/)
  // 同一条消息重推（SDK 的回调可能重复）不再送
  fake.push(textMsg('m1', 'alice', '这周的反馈'))
  await sleep(300)
  assert.equal(r.pushes.length, 1)
  const log = r.log()
  assert.ok(log.includes('[wecom]'), '日志按平台标')
  assert.ok(!/表情|状态卡片|补漏|撤回轮询/.test(log), `没有的功能整段跳过：\n${log}`)
  assert.ok(!log.includes('secret_example'), 'Secret 不进日志')
}))

test('企业微信 channel：白名单外的人默认丢掉；开了 observe 的单聊送进会话、标 trust="external"，「停」不当真', async () => {
  await withRig({}, async (r, fake) => {
    fake.push(textMsg('x1', 'bob', '外人'))
    await until(() => r.log().includes('丢弃 x1'), '丢弃')
    await sleep(200)
    assert.equal(r.pushes.length, 0)
  })
  await withRig({ observe: { dms: true } }, async (r, fake) => {
    fake.push(textMsg('x2', 'bob', '代理商反馈：小程序打不开'))
    await until(() => r.pushes.length === 1, '外部送达')
    assert.equal(r.pushes[0].meta.trust, 'external')
    assert.equal(r.pushes[0].meta.sender_id, 'bob')
    r.idle()
    fake.push(textMsg('x3', 'bob', '停'))
    await until(() => r.pushes.length === 2, '外部的「停」照常送达')
    assert.equal(r.pushes[1].content, '停')
    assert.ok(!r.log().includes('收到「停」'))
  })
})

test('企业微信 channel：白名单发「停」照常停，回执走主动推送', () => withRig({}, async (r, fake) => {
  fake.push(textMsg('s1', 'alice', '停'))
  await until(() => fake.sent.some(b => b.markdown.content.startsWith('已停')), '停的回执')
  assert.equal(fake.sent.at(-1).chatid, 'alice')
  assert.equal(r.pushes.length, 0)
}))

test('企业微信 channel：网络断了自动重连，断线后的消息照常送', () => withRig({}, async (r, fake) => {
  fake.drop()
  await until(() => fake.authed === 2, '重连')
  fake.push(textMsg('after', 'alice', '重连之后'))
  await until(() => r.pushes.some(p => p.meta.message_id === 'after'), '重连后送达')
  assert.ok(!existsSync(r.P.kicked))
}))

test('企业微信 channel：被另一处的新连接踢掉后不重连、reply 停用、告诉会话；重启也不抢，restart.mjs 删掉标记才再连', () => withRig({}, async (r, fake) => {
  fake.kick()
  await until(() => existsSync(r.P.kicked), '留下被踢标记')
  await until(() => r.pushes.some(p => p.content.includes('接管')), '告诉会话')
  const n = fake.subscribes
  await sleep(500)
  assert.equal(fake.subscribes, n, '被踢后没有再认证')
  const res = await r.call('reply', { chat_id: 'alice', text: 'x' })
  assert.ok(res.isError)
  assert.match(res.content[0].text, /接管/)
  // 常驻进程重启（外层循环拉起来）：看到标记就不连
  await r.stop()
  await r.start()
  await until(() => r.log().includes('这次不连'), '重启后不连')
  await sleep(300)
  assert.equal(fake.subscribes, n)
  // bin/restart.mjs：先删标记（常驻进程不归外层循环管时它杀完等不到新的，退出码 2，标记照样删掉）
  const out = spawnSync(process.execPath, [join(ROOT, 'bin', 'restart.mjs'), r.cfg], { env: { ...r.env, FEISHU_RESTART_WAIT_MS: '300' }, encoding: 'utf8' })
  assert.match(out.stdout, /已删除/)
  assert.ok(!existsSync(r.P.kicked))
  await r.stop()
  await r.start()
  await until(() => fake.authed === 2, '删了标记后重新连上')
}))

test('飞书和企业微信两个 channel 同一台机器、同一个状态目录同时跑：状态文件、端点不撞，各收各的', async () => {
  const fake = await startFake()
  const w = new Rig(fake)
  const dir = w.dir
  // 飞书：假适配器，配置和状态放在同一个目录
  writeFileSync(join(dir, 'messages.json'), '[]')
  const fcfg = join(dir, 'feishu-config.json')
  writeFileSync(fcfg, JSON.stringify({ appId: 'cli_me', appSecret: 'x', allow: ['ou_ok'], stateDir: dir, sweepSec: 0, recallPollSec: 0 }))
  const fP = paths({ appId: 'cli_me', stateDir: dir })
  const feishu = spawn(process.execPath, [join(ROOT, 'src', 'daemon.mjs')], { env: { ...process.env, FEISHU_CHANNEL_CONFIG: fcfg, FEISHU_ADAPTER: join(HERE, 'fake-feishu.mjs'), FAKE: dir }, stdio: 'ignore' })
  try {
    await w.start()
    await w.bridge()
    await until(() => existsSync(fP.log) && readFileSync(fP.log, 'utf8').includes('常驻进程启动'), '飞书常驻进程启动')
    assert.notEqual(fP.sock, w.P.sock)
    assert.notEqual(fP.state, w.P.state)
    assert.notEqual(fP.log, w.P.log)
    assert.equal(feishu.exitCode, null, '飞书常驻进程没因端点被占退出')
    await until(() => fake.authed === 1, '企业微信认证')
    fake.push(textMsg('w1', 'alice', '企业微信这边'))
    await until(() => w.pushes.length === 1, '企业微信送达')
    assert.ok(!readFileSync(fP.log, 'utf8').includes('w1'), '飞书那边没收到')
    assert.ok(readFileSync(w.P.log, 'utf8').includes('[wecom]'))
    assert.ok(readFileSync(fP.log, 'utf8').includes('[feishu]'))
  } finally {
    feishu.kill('SIGKILL')
    await w.close()
    fake.close()
  }
})

test('platform 写了不认识的值：常驻进程启动就报错退出，不回退成飞书', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-channel-'))
  try {
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({ platform: 'slack', appId: 'cli_me', allow: ['a'], stateDir: dir }))
    const r = spawnSync(process.execPath, [join(ROOT, 'src', 'daemon.mjs')], { env: { ...process.env, FEISHU_CHANNEL_CONFIG: cfg }, encoding: 'utf8', timeout: 20_000 })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /不认识的 platform/)
    assert.ok(!existsSync(join(dir, 'cli_me.log')), '没有按飞书跑起来')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
