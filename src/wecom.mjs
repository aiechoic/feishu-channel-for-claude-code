/**
 * 企业微信适配器：智能机器人的 API 模式 + 长连接，用官方 Node SDK（@wecom/aibot-node-sdk）。
 *
 * 适配器接口（飞书的 feishu.mjs 也照这个）：connect(cfg, log) 返回
 *   platform   平台名
 *   caps       支持哪些功能，没有的 daemon 整段跳过：card 状态卡片和置顶、reaction 回执表情、
 *              history 补拉（listChats / listMessages / getMessage）、recall 撤回、scopes 查权限
 *   isChatId   会话 id 的格式
 *   listen(h)  收消息；h 有 onConnected()、onMessage({ chat, chatType, message, eventMs })、onRecall(id)、
 *              onKicked(reason)（被另一处的新连接踢下线）、onFatal(why)（重试也没用的错误）。返回关连接的函数
 *   sendText(chat, text) → 发出去的消息 id
 *   以及 caps 里声明有的那些方法。message 的结构：{ message_id, msg_type, content, create_time, create_ms, deleted, sender: { id, sender_type, name } }
 *
 * 这里只做单聊：群里 @ 机器人的消息记日志后丢掉。
 * 收：文字原样；语音用企业微信转好的文字；图片、文件下载解密后存到 <状态目录>/<wecom-botId>-media/，正文给本地路径
 *   （下载地址 5 分钟就过期，收到就下）；视频只给占位。
 * 发：主动推送（aibot_send_msg）的 markdown。对方先给机器人发过消息才推得出去。
 * 同一个机器人同一时间只能有一条有效长连接，新连接会踢掉旧的：被踢时 SDK 不重连，这里报 onKicked，由 daemon 停用。
 * Secret 只从 botSecretFile 读，不写日志。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { WSClient as SdkClient } from '@wecom/aibot-node-sdk'
import { paths } from './common.mjs'
import { PLATFORMS } from './platform.mjs'

const stamp = ms => {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 回调里的 create_time：秒或毫秒都认；没有时用收到的时刻 */
export const toMs = t => {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 1e12 ? n * 1000 : n
}

/** 按文件头猜图片扩展名（回调里没有图片的文件名） */
function imageExt(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return '.png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return '.gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp'
  return '.img'
}

/** 落盘用的文件名：只留最后一段，去掉控制字符和路径分隔符，空了用 fallback */
export function safeName(name, fallback) {
  const s = basename(String(name ?? '')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim()
  return s && s !== '.' && s !== '..' ? s.slice(0, 120) : fallback
}

/** SDK 的日志接到我们的日志：debug 不要（会打出整条消息体），其余截短 */
const sdkLogger = log => {
  const line = (lvl, m, args) => log(`SDK ${lvl}：${[m, ...args].map(String).join(' ').slice(0, 300)}`)
  return {
    debug() {},
    info: (m, ...a) => line('info', m, a),
    warn: (m, ...a) => line('warn', m, a),
    error: (m, ...a) => line('error', m, a),
  }
}

/**
 * deps.WSClient 换掉 SDK 的客户端（单测用）。cfg.wsUrl 换长连接地址（私有部署；集成测试指向本地假服务）。
 */
export function connect(cfg, log, deps = {}) {
  const Client = deps.WSClient ?? SdkClient
  const secret = readFileSync(cfg.botSecretFile, 'utf8').trim()
  const client = new Client({
    botId: cfg.botId,
    secret,
    ...(cfg.wsUrl ? { wsUrl: cfg.wsUrl } : {}),
    maxReconnectAttempts: -1, // 网络断了一直重连（指数退避，最长 30 秒一次）
    ...(cfg.reconnectBaseMs ? { reconnectInterval: cfg.reconnectBaseMs } : {}),
    logger: sdkLogger(log),
  })
  const mediaDir = paths(cfg).media

  /** 下载解密一个附件，存盘，返回本地路径 */
  async function save(msgid, i, item, kind) {
    const { buffer, filename } = await client.downloadFile(item.url, item.aeskey)
    mkdirSync(mediaDir, { recursive: true })
    const fallback = `${kind}${kind === 'image' ? imageExt(buffer) : ''}`
    const name = safeName(filename ?? item.filename ?? item.name, fallback)
    const ext = extname(name) || (kind === 'image' ? imageExt(buffer) : '')
    const file = join(mediaDir, `${safeName(msgid, 'msg')}-${i}-${name.endsWith(ext) ? name : `${name}${ext}`}`)
    writeFileSync(file, buffer)
    return { file, name }
  }

  /** 附件 → 正文里的一行；下载失败也给一行，不丢整条消息 */
  async function media(msgid, i, item, kind) {
    const what = kind === 'image' ? '图片' : '文件'
    try {
      const { file, name } = await save(msgid, i, item, kind)
      return kind === 'image' ? `[图片] ${file}` : `[文件] ${file}（${name}）`
    } catch (e) {
      log(`${what}下载失败 ${msgid}：${e.message}`)
      return `[${what}下载失败：${e.message}]`
    }
  }

  /** 引用的那条：只给文字摘要，不下载 */
  function quoteText(q) {
    if (!q) return ''
    const body = q.msgtype === 'text' ? q.text?.content
      : q.msgtype === 'voice' ? q.voice?.content
        : q.msgtype === 'mixed' ? (q.mixed?.msg_item ?? []).map(x => (x.msgtype === 'text' ? x.text?.content : '[图片]')).join('')
          : `[${q.msgtype === 'image' ? '图片' : q.msgtype === 'file' ? '文件' : q.msgtype}]`
    return `> 引用：${String(body ?? '').replace(/\n/g, ' ').slice(0, 200)}\n`
  }

  /** 回调消息体 → 正文 */
  async function contentOf(b) {
    const id = b.msgid
    switch (b.msgtype) {
      case 'text': return b.text?.content ?? ''
      case 'voice': return b.voice?.content ?? ''
      case 'image': return media(id, 0, b.image ?? {}, 'image')
      case 'file': return media(id, 0, b.file ?? {}, 'file')
      case 'video': return '[视频] 暂不支持下载'
      case 'mixed': {
        const parts = []
        let i = 0
        for (const x of b.mixed?.msg_item ?? []) {
          if (x.msgtype === 'text') parts.push(x.text?.content ?? '')
          else if (x.msgtype === 'image') parts.push(await media(id, i++, x.image ?? {}, 'image'))
        }
        return parts.join('\n')
      }
      default: return `[${b.msgtype}]`
    }
  }

  const api = {
    platform: 'wecom',
    caps: { card: false, reaction: false, history: false, recall: false, scopes: false },
    isChatId: PLATFORMS.wecom.isChatId,

    /** 回调消息体 → { chat, chatType, message }；群消息返回 null（这次只做单聊） */
    async toEvent(b) {
      if (b?.chattype !== 'single') return null
      const createMs = toMs(b.create_time)
      const user = b.from?.userid ?? ''
      return {
        chat: user,
        chatType: 'p2p',
        eventMs: createMs,
        message: {
          message_id: b.msgid,
          msg_type: b.msgtype,
          deleted: false,
          content: `${quoteText(b.quote)}${await contentOf(b)}`,
          create_time: stamp(createMs),
          create_ms: createMs,
          sender: { id: user, sender_type: 'user', name: '' },
        },
      }
    },

    async sendText(chat, text) {
      const ack = await client.sendMessage(chat, { msgtype: 'markdown', markdown: { content: text } })
      return ack?.headers?.req_id ?? ''
    },

    listen(h) {
      client.on('authenticated', () => h.onConnected())
      client.on('reconnecting', n => log(`长连接断了，第 ${n} 次重连`))
      client.on('disconnected', reason => log(`长连接断开：${reason}`))
      client.on('event.disconnected_event', () => h.onKicked?.('同一个机器人在别处建了新的长连接'))
      client.on('error', e => {
        if (e?.code === 'WS_AUTH_FAILURE_EXHAUSTED') return h.onFatal?.(`认证一直失败，检查 botId 和 botSecretFile：${e.message}`)
        log(`长连接错误：${e?.message ?? e}`)
      })
      client.on('message', frame => {
        const b = frame?.body
        if (!b?.msgid) return
        if (b.chattype !== 'single') {
          log(`跳过群消息 ${b.msgid}（群 ${b.chatid ?? '?'}）：只收单聊`)
          return
        }
        api.toEvent(b).then(ev => ev && h.onMessage(ev)).catch(e => log(`处理消息 ${b.msgid} 失败：${e.message}`))
      })
      client.connect()
      return () => client.disconnect()
    },
  }
  return api
}
