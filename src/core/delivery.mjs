// 送达：闲时把队列里同一会话的消息合并成一条，经桥（bridge.mjs）送出，桥确认后出队。
// 忙时发送者的消息也立刻送，Claude Code 在下一次工具调用前后带进这一轮（标成外部内容）；说明、定时和停止标记在时等闲。
// 会话没就绪时 Claude Code 会静默丢掉通知，所以送出后等到 hook 才算唤醒，等不到退回队列重发。
// 连续 wakeRetryMax 次没唤醒就停发，消息留在队列，日志和状态卡报警；之后收到任何 hook 或新会话连上时恢复。
import { existsSync, rmSync } from 'node:fs'
import { ago } from './state.mjs'

const CLIP = 6000
const WAKE_TIMEOUT_MAX_MS = 300_000
const HALT_WARNING = '会话一直没唤醒，已停止重发'

export function install(ctx) {
  const { cfg, P, S, save, log, PLATFORM, rt } = ctx
  const WAKE_TIMEOUT_MS = (cfg.wakeTimeoutSec ?? 20) * 1000
  const WAKE_RETRY_MAX = cfg.wakeRetryMax ?? 10
  rt.pushing = null
  /** 忙时送出、不含白名单消息（只有外部发送者的消息或说明）的批数；它们进会话时触发的 UserPromptSubmit 不解除定时暂停 */
  rt.plainInjected = 0
  rt.waking = null // { batch, timer }：已送出、等会话唤醒
  rt.wakeTries = 0
  let wakeHalted = false // 连续 WAKE_RETRY_MAX 次没唤醒：闲时不再送，等 hook 或新会话

  /** 收到 hook 或新会话连上：会话还活着，停发的恢复送出（调用方接着会 deliver） */
  function resumeWake() {
    if (!wakeHalted) return false
    wakeHalted = false
    rt.wakeTries = 0
    ctx.warnings.delete(HALT_WARNING)
    log(`会话有动静了，恢复送出（排队 ${S.queue.length} 条）`)
    ctx.refreshCard()
    return true
  }

  function clip(text) {
    return text.length <= CLIP ? text : `${text.slice(0, CLIP)} …[已截断，${PLATFORM.fullTextHint}]`
  }

  /** 闲时：队首会话的排队（含说明、定时）合并送出，等 hook 确认唤醒；外部发送者的消息单独成一批，不和白名单的混。
   * 忙时：送发送者的消息和标了 urgent 的说明，其余说明和定时等闲；停止标记在时（「停」或撤回打断中）全部等闲 */
  function deliver() {
    if (!rt.bridge || rt.pushing || rt.waking || !S.queue.length) return
    const busy = S.busy
    if (wakeHalted && !busy) return
    if (busy && existsSync(P.stopFlag)) return
    const pool = busy ? S.queue.filter(m => !m.notice || m.urgent) : S.queue
    if (!pool.length) return
    const chat = pool[0].chat
    const external = Boolean(pool[0].external)
    const batch = pool.filter(m => m.chat === chat && Boolean(m.external) === external)
    const first = batch[0]
    const ids = batch.filter(m => !m.notice).map(m => m.message_id)
    const head = m => [m.label ?? m.message_id ?? '系统说明', m.sender_name, m.external && m.sender_id !== m.sender_name ? m.sender_id : '', m.create_time]
    const content = batch.length === 1
      ? clip(first.content)
      : batch.map(m => `[${head(m).filter(Boolean).join(' ')}]\n${clip(m.content)}`).join('\n\n')
    rt.pushing = { batch, busy, pushId: `${Date.now()}` }
    if (!busy) {
      rmSync(P.stopFlag, { force: true })
      ctx.setBusy('送出消息')
    }
    rt.bridge.sock.write(`${JSON.stringify({
      t: 'push',
      pushId: rt.pushing.pushId,
      content,
      meta: {
        chat_id: chat,
        chat_type: first.chat_type ?? 'group',
        message_id: ids.join(','),
        sender_id: first.sender_id ?? 'system',
        sender_name: first.sender_name ?? `${PLATFORM.label} channel`,
        sender_type: first.sender_type ?? 'system',
        msg_type: first.msg_type ?? 'text',
        create_time: first.create_time ?? '',
        merged: String(batch.length),
        ...(external ? { trust: 'external' } : {}),
        ...(rt.wakeTries && !busy ? { retry: String(rt.wakeTries) } : {}),
      },
    })}\n`)
  }

  function onAck(pushId) {
    if (rt.pushing?.pushId !== pushId) return
    const { batch, busy } = rt.pushing
    rt.pushing = null
    const sent = new Set(batch)
    S.queue = S.queue.filter(m => !sent.has(m))
    for (const m of batch) {
      if (m.notice) continue
      S.active.push(m.message_id)
      S.delivered[m.message_id] = { chat: m.chat, at: Date.now(), ...(m.external ? { external: true } : {}) }
      ctx.react(m.message_id, 'active')
    }
    log(`${busy ? '忙时送出' : '已送出'} ${batch.length} 条：${batch.map(m => (m.notice ? '说明' : `${m.message_id}（创建→送出 ${ago(m.createMs)}ms）`)).join(' ')}`)
    if (busy) {
      // 会话正在跑，Claude Code 在下一次工具调用前后把它带进这一轮，不用等唤醒；白名单的消息是新指令，同样恢复「停」暂停的定时
      if (batch.some(m => !m.notice && !m.external)) S.schedulesPaused = false
      else rt.plainInjected++
      save()
      ctx.refreshCard()
      deliver()
      return
    }
    save()
    ctx.refreshCard()
    const wait = Math.min(WAKE_TIMEOUT_MS * 2 ** rt.wakeTries, WAKE_TIMEOUT_MAX_MS)
    rt.waking = { batch, timer: setTimeout(notWoken, wait) }
    rt.waking.timer.unref()
  }

  function woke() {
    if (!rt.waking) return
    clearTimeout(rt.waking.timer)
    log(`已唤醒，送达确认 ${rt.waking.batch.length} 条`)
    rt.waking = null
    rt.wakeTries = 0
  }

  /** 通知被静默丢弃：退回队首重发。若其实收到了只是没触发 hook，会多送一次，meta.retry 标明，按 message_id 去重 */
  function notWoken() {
    const { batch } = rt.waking
    rt.waking = null
    rt.wakeTries++
    const ids = new Set(batch.map(m => m.message_id))
    S.active = S.active.filter(id => !ids.has(id))
    for (const id of ids) delete S.delivered[id]
    S.queue.unshift(...batch)
    batch.filter(m => !m.notice).forEach(m => ctx.react(m.message_id, 'queued'))
    if (rt.wakeTries >= WAKE_RETRY_MAX) {
      wakeHalted = true
      ctx.warnings.add(HALT_WARNING)
      log(`${batch.length} 条送出后没有唤醒会话，退回队列；连续 ${rt.wakeTries} 次没唤醒，停止重发，排队 ${S.queue.length} 条等会话下一次 hook`)
    } else {
      log(`${batch.length} 条送出后没有唤醒会话，退回队列，第 ${rt.wakeTries} 次重发`)
    }
    ctx.setIdle('未唤醒', false)
  }

  function enqueue(item) {
    S.queue.push(item)
    save()
    if (!item.notice) log(`入队${item.external ? '（外部发送者）' : ''} ${item.message_id}：创建→入队 ${ago(item.createMs)}ms，忙 ${S.busy}，桥 ${Boolean(rt.bridge)}`)
    deliver()
    if (!item.notice && !rt.pushing?.batch.includes(item)) ctx.react(item.message_id, 'queued')
    ctx.refreshCard()
  }

  Object.assign(ctx, { resumeWake, clip, deliver, onAck, woke, notWoken, enqueue })
}
