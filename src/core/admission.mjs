// 放行：按发送者 id（allow），或整群放行（allowChats 里的群，群里谁发都算）；其余丢弃并记日志。自己机器人发的跳过。
// 只送达（observe）：observe 为 true 时机器人在的全部会话，写成 { chats, dms } 时列出的群（和开了 dms 时的私信）里，
// 白名单外的人发的消息也入队，标成外部发送者（meta.trust=external）。和白名单的一样忙时送达，但不授权：
// 「停」当普通消息；撤回只从队列撤下，已送出的不拦工具、不杀进程，只补发作废说明（忙时也送）；送达不解除「停」暂停的定时。合并时不和白名单消息混在一条。
// 已读记录（seen）只在这里写：事件和补漏都从 admit 进门，已读过的不再处理。
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { ago, words } from './state.mjs'

const SENDER_CACHE_MAX = 1000

export function install(ctx) {
  const { cfg, P, S, save, log, im, CAPS, rt } = ctx
  const ALLOW = new Set(cfg.allow)
  const ALLOW_CHATS = new Set(cfg.allowChats ?? [])
  // observe: true 是机器人在的全部群和私信；写成 { chats, dms } 时只收这些
  const OBSERVE_ALL = cfg.observe === true
  const OBSERVE_CHATS = new Set(cfg.observe?.chats ?? [])
  const OBSERVE_DMS = Boolean(cfg.observe?.dms)
  /** 这个会话里白名单外的人发的消息也送（只送达、不授权） */
  const observed = (chat, isGroup) => OBSERVE_ALL || OBSERVE_CHATS.has(chat) || (!isGroup && OBSERVE_DMS)

  // 首次运行：还没有已读记录。安装时刻在首次启动时记下（已有部署取已读记录文件的创建时间），之后不变；
  // 第一次见到的会话只补安装时刻之后的消息，更早的记已读、不送
  rt.firstRun = !existsSync(P.seen)
  if (!S.installedAt) {
    const born = rt.firstRun ? 0 : statSync(P.seen).birthtimeMs
    S.installedAt = born > 0 ? Math.floor(born) : Date.now()
    save()
  }
  if (rt.firstRun) writeFileSync(P.seen, '')
  const seen = new Set(words(P.seen))
  const dmChats = new Set(words(P.dms))
  rt.me = ''

  function markSeen(id) {
    seen.add(id)
    appendFileSync(P.seen, `\n${id}`)
  }

  /** 私信会话记下来，补漏时也拉它 */
  function noteDm(chat) {
    if (dmChats.has(chat)) return
    dmChats.add(chat)
    appendFileSync(P.dms, `${chat}\n`)
  }

  /** 消息该不该送：'allow' 白名单、'external' 只送达、null 不送（不送的原因记日志） */
  function verdict(m, chat, isGroup) {
    const sender = m.sender?.id ?? ''
    if (m.deleted || ctx.eventRecalled.has(m.message_id)) {
      log(`跳过 ${m.message_id}：已撤回，创建→发现 ${ago(m.create_ms)}ms`)
      return null
    }
    if (sender === rt.me || m.msg_type === 'system') return null
    if (ALLOW.has(sender) || (isGroup && ALLOW_CHATS.has(chat))) return 'allow'
    if (observed(chat, isGroup)) return 'external'
    log(`丢弃 ${m.message_id}：发送者 ${sender} 不在白名单（会话 ${chat}）`)
    return null
  }

  /** 消息 → 队列条目（未读存的也是这个样子，read_unread 照它格式化） */
  function itemOf(m, chat, isGroup, external) {
    const s = m.sender ?? {}
    return {
      chat,
      chat_type: isGroup ? 'group' : 'p2p',
      message_id: m.message_id,
      content: m.content ?? '',
      sender_id: s.id ?? '',
      sender_name: cfg.names?.[s.id] || s.name || s.id || '',
      sender_type: s.sender_type ?? '',
      msg_type: m.msg_type ?? '',
      create_time: m.create_time ?? '',
      createMs: m.create_ms,
      ...(external ? { external: true } : {}),
    }
  }

  /** external：白名单外、只送达的发送者，整条「停」也当普通消息。fold：未读摘要，放在正文前 */
  function accept(m, chat, isGroup, external, fold) {
    if (!external && m.msg_type === 'text' && (m.content ?? '').trim() === '停') return ctx.doStop(chat, '收到「停」', m.message_id)
    const item = itemOf(m, chat, isGroup, external)
    if (fold) item.content = `${fold}\n\n${item.content}`
    ctx.enqueue(item)
  }

  /** 一条消息进门：放行判断和已读记录只在这里；事件和补漏都走这里，已读过的不再处理 */
  function admit(m, chat, isGroup, old, v) {
    if (seen.has(m.message_id)) return
    if (v === undefined) v = old ? null : verdict(m, chat, isGroup)
    if (v) accept(m, chat, isGroup, v === 'external')
    markSeen(m.message_id) // 入队落盘之后才记，崩在中间只会重收不会漏
  }

  /** 外部发送者的名字：消息里不带时按 id 问适配器（userName，没有就不查）。查到的记进状态文件（最多 1000 个）；
   * 查不到（没权限、不在通讯录范围）只在本进程里记，重启后再试，补了权限就能拿到 */
  const nameMissing = new Set()
  async function nameOf(id) {
    if (!id || cfg.names?.[id]) return cfg.names?.[id] ?? ''
    if (S.names?.[id]) return S.names[id]
    if (nameMissing.has(id)) return ''
    let name = ''
    try {
      name = (await im.userName?.(id)) ?? ''
    } catch (e) {
      log(`查不到 ${id} 的名字：${e.message}`)
    }
    if (!name) {
      nameMissing.add(id)
      return ''
    }
    S.names ??= {}
    S.names[id] = name
    const keys = Object.keys(S.names)
    if (keys.length > SENDER_CACHE_MAX) delete S.names[keys[0]]
    save()
    return name
  }

  /** 只送达的会话里白名单外的发送者：补上名字再进门 */
  async function withName(m, chat, isGroup) {
    const id = m.sender?.id
    if (!id || m.sender.name || ALLOW.has(id) || id === rt.me || !observed(chat, isGroup)) return m
    return { ...m, sender: { ...m.sender, name: await nameOf(id) } }
  }

  /** 长连接收到一条消息。没有历史接口的平台：事件里的发送者就是最终的，直接进门；有的交给 history 扩展确认发送者 */
  async function onEvent(ev) {
    const { chat, chatType, message: m } = ev
    if (chatType === 'p2p') noteDm(chat)
    if (CAPS.history) return ctx.onHistoryEvent(ev)
    if (!m?.message_id || seen.has(m.message_id)) return
    const isGroup = chatType !== 'p2p'
    try {
      admit(await withName(m, chat, isGroup), chat, isGroup)
    } catch (e) {
      log(`事件入队失败 ${m.message_id}：${e.message}`)
    }
  }

  Object.assign(ctx, { ALLOW, seen, dmChats, markSeen, verdict, itemOf, accept, admit, withName, onEvent })
}
