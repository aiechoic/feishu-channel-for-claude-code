// 假企业微信长连接服务：照官方 SDK 的帧格式回认证、心跳、主动推送的回执，能推消息、踢连接、断网、不回心跳；另起一个 HTTP 服务放加密的附件。
// 和真服务一样：同一个机器人新连接认证成功后，旧连接收到 disconnected_event 再被断开。
import { createCipheriv, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/** 照 SDK 的 decryptFile：AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 按 32 字节补齐 */
export function encryptFile(plain) {
  const key = randomBytes(32)
  const pad = 32 - (plain.length % 32)
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)])
  const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  c.setAutoPadding(false)
  return { data: Buffer.concat([c.update(padded), c.final()]), aeskey: key.toString('base64') }
}

export async function startFake({ botId = 'bot_example', secret = 'secret_example' } = {}) {
  const files = new Map() // path → { data, filename }
  const http = createServer((req, res) => {
    const f = files.get(req.url)
    if (!f) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream', ...(f.filename ? { 'content-disposition': `attachment; filename="${encodeURIComponent(f.filename)}"` } : {}) })
    res.end(f.data)
  })
  await new Promise(r => http.listen(0, '127.0.0.1', r))
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(r => wss.once('listening', r))

  const fake = {
    url: `ws://127.0.0.1:${wss.address().port}`,
    sent: [], // 收到的 aibot_send_msg 的 body
    responded: [], // 收到的被动回复 aibot_respond_msg：{ req_id, body }
    subscribes: 0, // 认证请求次数
    authed: 0, // 认证成功次数
    current: null, // 当前有效连接
    authOk: true,
    sendErr: 0, // 主动推送回执的 errcode
    pings: 0, // 收到的心跳次数
    mute: false, // 不回心跳（连接还在，对面不响应）
    secretsSeen: [],
    waiters: [],
    /** 推一条消息回调（body 照官方格式） */
    push(body) {
      fake.current?.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: `cb_${body.msgid}` }, body }))
    },
    /** 被同一个机器人的新连接挤掉：先推 disconnected_event，再断开 */
    kick(ws = fake.current) {
      ws?.send(JSON.stringify({ cmd: 'aibot_event_callback', headers: { req_id: 'ev_kick' }, body: { msgid: 'ev_kick', msgtype: 'event', from: { userid: '' }, event: { eventtype: 'disconnected_event' } } }))
      setTimeout(() => ws?.close(), 20)
      if (ws === fake.current) fake.current = null
    },
    /** 网络断了：直接掐断，不发事件 */
    drop() {
      fake.current?.terminate()
      fake.current = null
    },
    /** 放一个加密附件，返回回调里要带的 { url, aeskey } */
    file(plain, filename) {
      const { data, aeskey } = encryptFile(Buffer.from(plain))
      const path = `/media/${files.size + 1}`
      files.set(path, { data, filename })
      return { url: `http://127.0.0.1:${http.address().port}${path}`, aeskey }
    },
    close() {
      for (const c of wss.clients) c.terminate()
      wss.close()
      http.close()
    },
  }

  wss.on('connection', ws => {
    ws.on('message', raw => {
      const f = JSON.parse(String(raw))
      const id = f.headers?.req_id
      if (f.cmd === 'aibot_subscribe') {
        fake.subscribes++
        fake.secretsSeen.push(f.body?.secret)
        const ok = fake.authOk && f.body?.bot_id === botId && f.body?.secret === secret
        ws.send(JSON.stringify({ headers: { req_id: id }, errcode: ok ? 0 : 40058, errmsg: ok ? 'ok' : 'invalid secret' }))
        if (!ok) return
        fake.authed++
        const old = fake.current
        fake.current = ws
        if (old && old !== ws) fake.kick(old)
      } else if (f.cmd === 'ping') {
        fake.pings++
        if (!fake.mute) ws.send(JSON.stringify({ headers: { req_id: id }, errcode: 0, errmsg: 'ok' }))
      } else if (f.cmd === 'aibot_respond_msg') {
        fake.responded.push({ req_id: id, body: f.body })
        ws.send(JSON.stringify({ headers: { req_id: id }, errcode: 0, errmsg: 'ok' }))
      } else if (f.cmd === 'aibot_send_msg') {
        fake.sent.push(f.body)
        ws.send(JSON.stringify({ headers: { req_id: id }, errcode: fake.sendErr, errmsg: fake.sendErr ? 'not allowed' : 'ok' }))
      }
    })
  })
  return fake
}

/** 单聊文字消息的回调体 */
export const textMsg = (msgid, userid, content, extra = {}) => ({
  msgid, aibotid: 'bot_example', chattype: 'single', from: { userid }, create_time: Math.floor(Date.now() / 1000), msgtype: 'text', text: { content }, ...extra,
})
