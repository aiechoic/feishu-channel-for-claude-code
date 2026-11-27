// 企业微信适配器：真 SDK 连本地假服务（fake-wecom-server.mjs），覆盖收、回、重连、被踢、认证失败、Secret 不进日志
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { connect, mediaKindOf, safeName, stripMention, toMs, withImageExt } from '../src/wecom.mjs'
import { startFake, textMsg } from './fake-wecom-server.mjs'

async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(25)
  }
  assert.fail(`超时：${what}`)
}

async function setup(extra = {}) {
  const fake = await startFake()
  const dir = mkdtempSync(join(tmpdir(), 'wecom-adapter-'))
  writeFileSync(join(dir, 'secret'), 'secret_example\n')
  const cfg = { platform: 'wecom', botId: 'bot_example', botSecretFile: join(dir, 'secret'), allow: ['alice'], stateDir: dir, wsUrl: fake.url, reconnectBaseMs: 20, ...extra }
  const logs = []
  const im = connect(cfg, m => logs.push(m))
  const got = { connected: 0, messages: [], kicked: [], fatal: [] }
  const stop = im.listen({
    onConnected: () => got.connected++,
    onMessage: ev => got.messages.push(ev),
    onRecall: () => {},
    onKicked: r => got.kicked.push(r),
    onFatal: w => got.fatal.push(w),
  })
  const done = () => {
    stop()
    fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { fake, dir, cfg, im, got, logs, done }
}

test('企业微信适配器：能力表关掉卡片、表情、补拉、撤回、查权限；会话 id 是 userid', async () => {
  const s = await setup()
  try {
    assert.equal(s.im.platform, 'wecom')
    assert.deepEqual(s.im.caps, { card: false, reaction: false, history: false, recall: false, scopes: false })
    assert.ok(s.im.isChatId('zhang.san'))
    assert.ok(!s.im.isChatId('a b'))
    assert.ok(!s.im.isChatId(''))
  } finally { s.done() }
})

test('企业微信适配器：单聊文字、引用照收；语音只给提示；群里 @ 的消息会话 id 是 chatid，去掉开头的 @', async () => {
  const s = await setup()
  try {
    await until(() => s.got.connected === 1, '认证')
    s.fake.push(textMsg('m1', 'alice', '你好'))
    s.fake.push({ ...textMsg('m2', 'alice', ''), msgtype: 'voice', voice: { content: '企业微信转的文字' }, text: undefined })
    s.fake.push({ ...textMsg('m3', 'alice', '回这条'), quote: { msgtype: 'text', text: { content: '原来那句' } } })
    s.fake.push({ ...textMsg('g1', 'bob', '@测试机器人 群里问一句'), chattype: 'group', chatid: 'chat_example' })
    s.fake.push({ ...textMsg('g2', 'bob', 'x'), chattype: 'group' })
    await until(() => s.got.messages.length === 4, '三条单聊 + 一条群聊')
    const [a, b, c, g] = s.got.messages
    assert.equal(a.chat, 'alice')
    assert.equal(a.chatType, 'p2p')
    assert.equal(a.message.message_id, 'm1')
    assert.equal(a.message.content, '你好')
    assert.deepEqual(a.message.sender, { id: 'alice', sender_type: 'user', name: '' })
    assert.ok(Math.abs(a.message.create_ms - Date.now()) < 60_000, '秒级时间戳换成毫秒')
    assert.equal(b.message.msg_type, 'voice')
    assert.equal(b.message.content, '[语音] 暂不支持语音，请发文字')
    assert.equal(c.message.content, '> 引用：原来那句\n回这条')
    assert.equal(g.chat, 'chat_example')
    assert.equal(g.chatType, 'group')
    assert.equal(g.message.sender.id, 'bob')
    assert.equal(g.message.content, '群里问一句')
  } finally { s.done() }
})

test('企业微信适配器：图片、文件、图文混排下载解密后落盘，正文给本地路径；图片扩展名按内容；下载失败也给一行', async () => {
  const s = await setup()
  try {
    await until(() => s.got.connected === 1, '认证')
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')])
    s.fake.push({ ...textMsg('img1', 'alice'), msgtype: 'image', image: s.fake.file(png), text: undefined })
    s.fake.push({ ...textMsg('file1', 'alice'), msgtype: 'file', file: s.fake.file('报告内容', '周报 v1.txt'), text: undefined })
    s.fake.push({ ...textMsg('mix1', 'alice'), msgtype: 'mixed', text: undefined, mixed: { msg_item: [{ msgtype: 'text', text: { content: '看图' } }, { msgtype: 'image', image: s.fake.file(png) }] } })
    s.fake.push({ ...textMsg('bad1', 'alice'), msgtype: 'image', image: { url: `${s.fake.file('x').url}-missing`, aeskey: 'AAAA' }, text: undefined })
    s.fake.push({ ...textMsg('vid1', 'alice'), msgtype: 'video', video: { url: 'http://127.0.0.1:1/v', aeskey: 'AAAA' }, text: undefined })
    // 「图片」入口发的压缩图：下载给的名字是 .png，内容是 JPEG
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('jpeg body')])
    s.fake.push({ ...textMsg('img2', 'alice'), msgtype: 'image', image: s.fake.file(jpg, '06ad41c9_compress.png'), text: undefined })
    await until(() => s.got.messages.length === 6, '六条')
    const by = Object.fromEntries(s.got.messages.map(e => [e.message.message_id, e.message]))
    const img = /^\[图片\] (.+)$/.exec(by.img1.content)?.[1]
    assert.ok(img?.endsWith('.png'), by.img1.content)
    assert.deepEqual(readFileSync(img), png, '解密后和原图一样')
    const file = /^\[文件\] (.+)（周报 v1\.txt）$/.exec(by.file1.content)?.[1]
    assert.ok(file, by.file1.content)
    assert.equal(readFileSync(file, 'utf8'), '报告内容')
    assert.ok(file.startsWith(join(s.dir, 'wecom-bot_example-media')), '存在状态目录下')
    const [t, m] = by.mix1.content.split('\n')
    assert.equal(t, '看图')
    assert.deepEqual(readFileSync(/^\[图片\] (.+)$/.exec(m)[1]), png)
    assert.match(by.bad1.content, /^\[图片下载失败：/)
    assert.equal(by.vid1.content, '[视频] 暂不支持下载')
    const img2 = /^\[图片\] (.+)$/.exec(by.img2.content)?.[1]
    assert.ok(img2?.endsWith('-0-06ad41c9_compress.jpg'), by.img2.content)
    assert.deepEqual(readFileSync(img2), jpg)
  } finally { s.done() }
})

test('企业微信适配器：sendText 走主动推送的 markdown；带 replyTo 走被动回复；回执报错时抛出', async () => {
  const s = await setup()
  try {
    await until(() => s.got.connected === 1, '认证')
    const id = await s.im.sendText('alice', '收到，**谢谢**')
    assert.ok(id)
    assert.deepEqual(s.fake.sent, [{ chatid: 'alice', msgtype: 'markdown', markdown: { content: '收到，**谢谢**' } }])
    // 带 replyTo：被动回复那条（req_id 是那条回调的），找不到退回主动推送
    s.fake.push({ ...textMsg('q1', 'alice', '@机器人 问'), chattype: 'group', chatid: 'chat_q' })
    await until(() => s.got.messages.length === 1, '群消息')
    await s.im.sendText('chat_q', '答', { replyTo: 'q1' })
    assert.deepEqual(s.fake.responded, [{ req_id: 'cb_q1', body: { msgtype: 'markdown', markdown: { content: '答' } } }])
    await s.im.sendText('chat_q', '答2', { replyTo: 'nope' })
    await s.im.sendText('alice', '答3', { replyTo: 'q1' })
    assert.deepEqual(s.fake.sent.slice(1).map(b => b.chatid), ['chat_q', 'alice'], '找不到或会话不对就直接发')
    assert.ok(s.logs.some(l => l.includes('找不到原消息')))
    s.fake.sendErr = 600039
    await assert.rejects(() => s.im.sendText('alice', '再发一条'))
  } finally { s.done() }
})

test('企业微信适配器：网络断了自动重连，重连后照常收', async () => {
  const s = await setup()
  try {
    await until(() => s.got.connected === 1, '认证')
    s.fake.drop()
    await until(() => s.got.connected === 2, '重连后再认证')
    s.fake.push(textMsg('after', 'alice', '重连之后'))
    await until(() => s.got.messages.some(e => e.message.message_id === 'after'), '重连后收到')
    assert.equal(s.got.kicked.length, 0)
  } finally { s.done() }
})

test('企业微信适配器：心跳没有回执时当断线，自己断开重连', async () => {
  const s = await setup({ heartbeatMs: 40 })
  try {
    await until(() => s.got.connected === 1, '认证')
    await until(() => s.fake.pings >= 2, '心跳在发')
    s.fake.mute = true
    await until(() => s.got.connected === 2, '心跳断了之后重连')
    s.fake.mute = false
    s.fake.push(textMsg('hb', 'alice', '心跳恢复后'))
    await until(() => s.got.messages.some(e => e.message.message_id === 'hb'), '重连后收到')
    assert.equal(s.got.kicked.length, 0)
    assert.ok(s.logs.some(l => l.includes('长连接断开')), s.logs.join(' | '))
  } finally { s.done() }
})

test('企业微信适配器：被同一个机器人的新连接踢掉时报 onKicked，不重连抢回来', async () => {
  const s = await setup()
  try {
    await until(() => s.got.connected === 1, '认证')
    s.fake.kick()
    await until(() => s.got.kicked.length === 1, '报被踢')
    const n = s.fake.subscribes
    await sleep(500) // 重连间隔 20ms，真重连的话这段时间里早连回来了
    assert.equal(s.fake.subscribes, n, '没有再认证')
    assert.equal(s.got.connected, 1)
  } finally { s.done() }
})

test('企业微信适配器：Secret 错了重试几次后报 onFatal；Secret 只发给服务端，不进日志', async () => {
  const fake = await startFake()
  const dir = mkdtempSync(join(tmpdir(), 'wecom-adapter-'))
  writeFileSync(join(dir, 'secret'), 'wrong_secret_value\n')
  const logs = []
  const fatal = []
  const im = connect({ platform: 'wecom', botId: 'bot_example', botSecretFile: join(dir, 'secret'), allow: ['a'], stateDir: dir, wsUrl: fake.url, reconnectBaseMs: 10 }, m => logs.push(m))
  const stop = im.listen({ onConnected() {}, onMessage() {}, onKicked() {}, onFatal: w => fatal.push(w) })
  try {
    await until(() => fatal.length === 1, '认证失败用尽')
    assert.match(fatal[0], /认证一直失败/)
    assert.ok(fake.secretsSeen.every(x => x === 'wrong_secret_value'), 'Secret 去掉了文件末尾的换行')
    assert.ok(!logs.join('\n').includes('wrong_secret_value'), 'Secret 不在日志里')
  } finally {
    stop()
    fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('企业微信适配器：文件名去掉路径和非法字符；图片扩展名按内容定；时间戳秒、毫秒都认', () => {
  assert.equal(safeName('../../etc/passwd', 'f'), 'passwd')
  assert.equal(safeName('a:b*c?.txt', 'f'), 'a_b_c_.txt')
  assert.equal(safeName('', 'f'), 'f')
  assert.equal(safeName('..', 'f'), 'f')
  assert.equal(safeName('C:\\tmp\\x.txt', 'f'), 'x.txt')
  assert.equal(withImageExt('a_compress.png', '.jpg'), 'a_compress.jpg')
  assert.equal(withImageExt('a.JPEG', '.jpg'), 'a.JPEG')
  assert.equal(withImageExt('a.png', '.png'), 'a.png')
  assert.equal(withImageExt('image', '.gif'), 'image.gif')
  assert.equal(withImageExt('a.png', '.img'), 'a.png')
  assert.equal(withImageExt('image', '.img'), 'image.img')
  assert.equal(mediaKindOf('a.PNG', 1000), 'image')
  assert.equal(mediaKindOf('a.jpg', 11 << 20), 'file', '超过 10MB 的图片按文件发')
  assert.equal(mediaKindOf('a.pdf', 1000), 'file')
  assert.throws(() => mediaKindOf('a.zip', 21 << 20), /20MB/)
  assert.equal(stripMention('@机器人 你好'), '你好')
  assert.equal(stripMention('  @机器人'), '')
  assert.equal(stripMention('你好 @机器人'), '你好 @机器人')
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(toMs(1_700_000_000_123), 1_700_000_000_123)
  assert.ok(Math.abs(toMs(undefined) - Date.now()) < 1000)
})
