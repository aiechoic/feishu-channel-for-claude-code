// 飞书适配器：只用官方 Node SDK。daemon 只依赖这里导出的接口，测试用 FEISHU_ADAPTER 换成假实现。
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as lark from '@larksuiteoapi/node-sdk'

const secret = cfg => process.env.FEISHU_APP_SECRET
  ?? (cfg.appSecretFile ? readFileSync(cfg.appSecretFile, 'utf8').trim() : cfg.appSecret)

const stamp = ms => {
  const d = new Date(Number(ms))
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function postText(body) {
  const lang = body.content ? body : Object.values(body)[0] ?? {}
  const lines = (lang.content ?? []).map(row => row.map(n => (n.href ? `[${n.text ?? ''}](${n.href})` : n.text ?? `[${n.tag}]`)).join(''))
  return [lang.title, ...lines].filter(Boolean).join('\n')
}

/** 飞书原始 content JSON → 给模型看的文本；图片、文件只放占位和 key */
export function formatContent(type, raw) {
  let body
  try {
    body = JSON.parse(raw ?? '{}')
  } catch {
    return raw ?? ''
  }
  switch (type) {
    case 'text': return body.text ?? ''
    case 'post': return postText(body)
    case 'image': return `[Image: ${body.image_key}]`
    case 'file': return `<file key="${body.file_key}" name="${body.file_name}"/>`
    default: return `[${type}] ${raw ?? ''}`
  }
}

const normal = m => ({
  message_id: m.message_id,
  msg_type: m.msg_type,
  deleted: Boolean(m.deleted),
  content: formatContent(m.msg_type, m.body?.content),
  create_time: stamp(m.create_time),
  create_ms: Number(m.create_time),
  sender: { id: m.sender?.id ?? '', sender_type: m.sender?.sender_type ?? '', name: m.sender?.name ?? '' },
})

/** 收消息事件 → 和列表接口同样的消息结构。事件里的发送者只有 open_id，机器人也一样，没有 cli_ 开头的 app id，也没有名字 */
export const fromEvent = ({ message: m, sender: s }) => normal({
  ...m,
  msg_type: m.message_type,
  body: { content: m.content },
  sender: { id: s?.sender_id?.open_id ?? '', sender_type: s?.sender_type ?? '' },
})

/** 网络错误重试；发消息带同一个 uuid，服务端去重，不会发两条 */
export async function withRetry(fn, { tries = 3, waitMs = 1000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries || e.feishuCode) throw e
      await new Promise(r => setTimeout(r, waitMs * i))
    }
  }
}

const ok = r => {
  if (r?.code) throw Object.assign(new Error(`飞书接口 ${r.code}: ${r.msg}`), { feishuCode: r.code })
  return r?.data
}

export function connect(cfg, log) {
  const base = {
    appId: cfg.appId,
    appSecret: secret(cfg),
    domain: cfg.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
  }
  const client = new lark.Client(base)
  return {
    async grantedScopes() {
      const data = ok(await client.request({ method: 'GET', url: '/open-apis/application/v6/scopes' }))
      return (data.scopes ?? []).filter(s => s.grant_status === 1).map(s => s.scope_name)
    },
    async listChats() {
      const out = []
      for await (const page of await client.im.chat.listWithIterator({ params: { page_size: 100 } })) out.push(...(page?.items ?? []))
      return out.map(c => c.chat_id)
    },
    async listMessages(chat, pageToken) {
      const data = ok(await client.im.message.list({
        params: { container_id_type: 'chat', container_id: chat, sort_type: 'ByCreateTimeDesc', page_size: 50, with_sender_name: true, ...(pageToken ? { page_token: pageToken } : {}) },
      }))
      return { messages: (data.items ?? []).map(normal), hasMore: Boolean(data.has_more), pageToken: data.page_token }
    },
    async getMessage(id) {
      const data = ok(await client.im.message.get({ path: { message_id: id } }))
      return data.items?.[0] ? normal(data.items[0]) : null
    },
    async sendText(chat, text) {
      const uuid = randomUUID()
      return withRetry(async () => ok(await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chat, msg_type: 'text', content: JSON.stringify({ text }), uuid },
      })).message_id)
    },
    async addReaction(id, emoji) {
      return ok(await client.im.messageReaction.create({ path: { message_id: id }, data: { reaction_type: { emoji_type: emoji } } })).reaction_id
    },
    async removeReaction(id, reactionId) {
      ok(await client.im.messageReaction.delete({ path: { message_id: id, reaction_id: reactionId } }))
    },
    async sendCard(chat, content) {
      const data = ok(await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chat, msg_type: 'interactive', content },
      }))
      return data.message_id
    },
    async patchCard(id, content) {
      ok(await client.im.message.patch({ path: { message_id: id }, data: { content } }))
    },
    async pin(id) {
      ok(await client.im.pin.create({ data: { message_id: id } }))
    },
    /** handlers: onConnected()、onMessage({ chat, chatType, message, eventMs })、onRecall(messageId, { recallMs, eventMs }) */
    listen(handlers) {
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async e => handlers.onMessage({
          chat: e.message.chat_id,
          chatType: e.message.chat_type,
          message: fromEvent(e),
          eventMs: Number(e.create_time),
        }),
        'im.message.recalled_v1': async e => handlers.onRecall(e.message_id, { recallMs: Number(e.recall_time), eventMs: Number(e.create_time) }),
      })
      const ws = new lark.WSClient({
        ...base,
        autoReconnect: true,
        onReady: handlers.onConnected,
        onReconnected: handlers.onConnected,
        onError: e => log(`长连接错误：${e.message}`),
      })
      ws.start({ eventDispatcher: dispatcher })
      return () => ws.close?.()
    },
  }
}
