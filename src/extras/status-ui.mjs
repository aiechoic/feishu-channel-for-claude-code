// 平台侧的状态展示：回执表情和置顶的状态卡片（适配器 caps.reaction / caps.card 有才做）。
// 都排进 ctx.effect 的串行队列，失败只记日志。别的模块只调 ctx.react(id, kind) 和 ctx.refreshCard()，平台没有这些能力时是空操作。
import { wall } from '../schedule.mjs'
import { hhmm } from '../core/state.mjs'

const EMOJI = { queued: 'GLANCE', active: 'OneSecond', done: 'CheckMark', stopped: 'CrossMark' }
const CARD_RETRY_MS = 30_000

export function install(ctx) {
  const { cfg, S, save, log, im, box, CAPS, rt } = ctx
  const CARD_DEBOUNCE_MS = (cfg.cardDebounceSec ?? 5) * 1000

  const { effect } = ctx

  function react(id, kind) {
    if (!CAPS.reaction || !id || S.reactions[id]?.kind === kind) return
    S.reactions[id] = { kind, id: S.reactions[id]?.id ?? '' }
    effect(`表情 ${id}`, async () => {
      const old = S.reactions[id]?.id // 串行执行到这里时前一个表情的 id 才可用
      if (old) {
        await im.removeReaction(id, old)
      }
      const reactionId = await im.addReaction(id, EMOJI[kind])
      if (S.reactions[id]) S.reactions[id].id = reactionId
      save()
    })
  }

  function cardBody() {
    const offline = !rt.bridge
    const state = offline ? '离线' : S.busy ? '忙' : '闲'
    const lines = [`**状态**：${state}（${hhmm(S.since)} 起）`, `**排队**：${S.queue.length} 条`]
    if (S.busy && rt.tool) lines.splice(1, 0, `**当前工具**：${rt.tool}`)
    const upcoming = ctx.nextSchedule()
    ctx.warnings.forEach(w => lines.push(`**提示**：${w}`))
    for (const [chat, u] of Object.entries(S.unread ?? {})) lines.push(`**未读**：${u.name || chat} 还有 ${u.items.length} 条`)
    if (S.schedulesPaused) lines.push('**定时**：已暂停')
    else if (upcoming) lines.push(`**下一个定时**：${wall(upcoming.nextAt, ctx.TZ)}`)
    return {
      config: { update_multi: true },
      header: { template: offline ? 'grey' : S.busy ? 'orange' : 'green', title: { tag: 'plain_text', content: `${cfg.name ?? 'Claude Code'} ${state}` } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
    }
  }

  let cardShown = ''
  let cardTimer = null
  function refreshCard() {
    if (!CAPS.card || !cfg.statusChat || cardTimer) return
    cardTimer = setTimeout(() => {
      cardTimer = null
      const content = JSON.stringify(cardBody())
      if (content === cardShown) return
      cardShown = content
      effect('状态卡片', async () => {
        if (S.card) {
          await im.patchCard(S.card, content)
          return
        }
        S.card = await box.send(cfg.statusChat, () => im.sendCard(cfg.statusChat, content))
        save()
        // 旧卡片的置顶先取消（换了机器、状态目录丢了时本机没有记录），群里只留一张；失败不挡新卡片置顶
        try {
          const gone = await im.unpinOwn(cfg.statusChat, S.card)
          if (gone.length) log(`取消旧置顶 ${gone.join(' ')}`)
        } catch (e) { log(`取消旧置顶失败：${e.message}`) }
        await im.pin(S.card)
      }, () => { // 下次检查时重发，不让卡片停在旧状态
        cardShown = ''
        setTimeout(refreshCard, CARD_RETRY_MS).unref()
      })
    }, CARD_DEBOUNCE_MS)
  }

  Object.assign(ctx, { react, refreshCard })
}
