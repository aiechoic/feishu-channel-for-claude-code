// 撤回（适配器 caps.recall 有才轮询）：撤回事件 + 低频轮询兜底。排队中的撤下；正在处理的打断这一轮；已处理完的只作废。都不暂停定时。
// 撤回事件由 listen 的 onRecall 送来，所有平台都会走 onRecall；没有撤回能力的平台只是不会收到。
export function install(ctx) {
  const { cfg, S, save, log, im, CAPS } = ctx
  const RECALL_POLL_MS = (cfg.recallPollSec ?? 60) * 1000
  const RECALL_WINDOW_MS = (cfg.recallWindowSec ?? 3600) * 1000
  const RECALL_HINT_MS = (cfg.recallHintSec ?? 30) * 1000
  const RECALL_HINT = '撤回事件可能没订阅'
  /** 收到过撤回事件的 message_id：放行判断时跳过 */
  const eventRecalled = new Set()
  let hinted = false

  /** 轮询先发现时等一会，事件还是没来才提示；重启空档里的撤回本来就收不到事件，不算 */
  function suspectNoRecallEvent(id) {
    if (hinted || Date.now() - ctx.startedAt < RECALL_POLL_MS * 2) return
    setTimeout(() => {
      if (hinted || eventRecalled.has(id)) return
      hinted = true
      ctx.warnings.add(RECALL_HINT)
      log(`${RECALL_HINT}：${id} 只有轮询发现，没有收到事件`)
      ctx.refreshCard()
    }, RECALL_HINT_MS).unref()
  }

  async function pollRecalls() {
    const now = Date.now()
    for (const [id, d] of Object.entries(S.delivered)) {
      if (now - d.at > RECALL_WINDOW_MS) delete S.delivered[id]
    }
    const ids = [...S.queue.filter(m => !m.notice).map(m => m.message_id), ...Object.keys(S.delivered)]
    for (const id of ids) {
      const m = await im.getMessage(id)
      if (m?.deleted) {
        log(`轮询发现撤回 ${id}`)
        onRecall(id)
        suspectNoRecallEvent(id)
      }
    }
  }

  function onRecall(id) {
    for (const [chat, u] of Object.entries(S.unread ?? {})) {
      if (!u.items.some(m => m.message_id === id)) continue
      u.items = u.items.filter(m => m.message_id !== id)
      if (!u.items.length) delete S.unread[chat]
      log(`未读中撤回 ${id}，移出未读`)
      save()
      ctx.refreshCard()
      return
    }
    const queued = S.queue.find(m => m.message_id === id)
    if (queued) {
      S.queue = S.queue.filter(m => m !== queued)
      delete S.reactions[id]
      log(`排队中撤回 ${id}，不送`)
      save()
      ctx.refreshCard()
      ctx.effect('撤回回执', () => ctx.send(queued.chat, `消息 ${id} 已从队列撤下`))
      return
    }
    const d = S.delivered[id]
    if (!d) return
    const running = S.busy && S.active.includes(id) && !d.external // 外部发送者撤回不打断这一轮
    delete S.delivered[id]
    delete S.reactions[id]
    S.active = S.active.filter(a => a !== id)
    if (!running) {
      log(`${d.external ? '外部发送者的消息送达后撤回' : '处理完后撤回'} ${id}`)
      ctx.effect('撤回回执', () => ctx.send(d.chat, `消息 ${id} 已作废`))
      // 外部发送者的不打断这一轮：作废说明忙时也送，要不要停下手上的事由会话自己判断
      ctx.enqueue(d.external
        ? { notice: true, urgent: true, chat: d.chat, content: `消息 ${id}（外部发送者）已撤回，内容作废。程序没有打断这一轮，要不要停下手上相关的事自己判断` }
        : { notice: true, chat: d.chat, content: `消息 ${id} 已撤回、作废，那一轮已经结束，不要再按它继续做` })
      return
    }
    const peers = [...S.active]
    peers.forEach(a => ctx.react(a, 'stopped'))
    S.active = []
    const killed = ctx.interrupt(`消息 ${id} 撤回`)
    log(`处理中撤回 ${id}：打断这一轮，杀工具 ${killed}`)
    save()
    ctx.effect('撤回回执', () => ctx.send(d.chat, `消息 ${id} 已撤回，正在处理它的这一轮已打断。${killed ? '当前工具进程已杀。' : ''}`))
    ctx.enqueue({ notice: true, chat: d.chat, content: `消息 ${id} 已撤回、作废，已开始的部分停下并报告做了什么${peers.length ? `。同一轮的 ${peers.join(' ')} 没有撤回，仍要处理` : ''}` })
  }

  /** 撤回事件到达 */
  function onRecallEvent(id) {
    eventRecalled.add(id)
    onRecall(id)
  }

  /** 启动后开始轮询（只有支持撤回的平台） */
  function startRecallPoll() {
    if (!(RECALL_POLL_MS > 0 && CAPS.recall)) return
    const poll = () => pollRecalls().catch(e => log(`撤回轮询失败：${e.message}`)).finally(() => setTimeout(poll, RECALL_POLL_MS).unref())
    setTimeout(poll, RECALL_POLL_MS).unref()
  }

  Object.assign(ctx, { eventRecalled, onRecallEvent, startRecallPoll })
}
