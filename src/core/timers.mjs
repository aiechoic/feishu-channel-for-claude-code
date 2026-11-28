// 定时：到点进同一条队列；会话不在线或「停」之后不触发，等恢复后再判宽限期，过了宽限期只回报跳过。
// 每条定时记着自己的会话（加的时候的 chat_id，没填用 statusChat）：到点的通知记在它名下，过了宽限期的跳过回报也发到那里。
// 两个都没有时不让加；没记会话的旧定时在没配 statusChat 时不触发，列表里标出来。
import { next, parseAdd, procStart, wall } from '../schedule.mjs'

const LATE_MS = 60_000

function lateness(ms) {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`
}

export function install(ctx) {
  const { cfg, S, save, log, rt, TZ, PLATFORM } = ctx
  const GRACE_MIN = { once: cfg.onceGraceMin ?? 10_080, daily: cfg.repeatGraceMin ?? 720, weekly: cfg.repeatGraceMin ?? 720 }
  const TICK_MS = (cfg.scheduleTickSec ?? 15) * 1000

  const chatOf = job => job.chat || cfg.statusChat || ''

  /** 加定时时记的会话：chat_id 要是本平台的会话 id；没填用 statusChat，两个都没有就不加 */
  function chatFor(id) {
    if (id === undefined || id === null || id === '') {
      if (cfg.statusChat) return cfg.statusChat
      throw new Error('没配 statusChat，也没传 chat_id：这条定时没有会话可记，不加。传 chat_id（取 <channel> 标签里的），或在配置里写 statusChat')
    }
    if (!PLATFORM.isChatId(id) || PLATFORM.isForeignChatId?.(id)) throw new Error(`chat_id 要是${PLATFORM.label}的会话 id（${PLATFORM.chatIdHint}）：${id}`)
    return id
  }

  function nextSchedule() {
    return S.schedules.filter(j => j.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0]
  }

  function fire(job, chat, label) {
    ctx.enqueue({ notice: true, label: `定时 ${job.id}`, scheduleId: job.id, chat, content: `[定时 ${job.id}]${label} ${job.text}` })
    log(`定时 ${job.id} 触发`)
  }

  function tick() {
    if (!rt.bridge || S.schedulesPaused) return
    const now = Date.now()
    for (const job of [...S.schedules]) {
      const chat = chatOf(job)
      if (!chat) continue
      if (job.kind === 'process') {
        if (procStart(job.pid) === job.start) continue
        fire(job, chat, `（进程 ${job.pid} 已结束，${wall(now, TZ)} 发现）`)
      } else {
        if (job.nextAt > now) continue
        const late = now - job.nextAt
        if (late <= (job.graceMin ?? GRACE_MIN[job.kind]) * 60_000) {
          fire(job, chat, late > LATE_MS ? `（原定 ${wall(job.nextAt, TZ)}，晚了 ${lateness(late)}）` : `（${wall(job.nextAt, TZ)}）`)
        } else {
          log(`定时 ${job.id} 过了宽限期，跳过`)
          ctx.effect('定时跳过回报', () => ctx.send(chat, `定时 ${job.id} 原定 ${wall(job.nextAt, TZ)}，过了宽限期没有补发：${job.text}`))
        }
      }
      if (job.kind === 'daily' || job.kind === 'weekly') job.nextAt = next(job, TZ, now)
      else S.schedules = S.schedules.filter(j => j !== job)
      save()
      ctx.refreshCard()
    }
  }

  /** 列表里的一条：到点没触发的写明为什么 */
  function listLine(j, now) {
    const when = j.kind === 'process' ? `等进程 ${j.pid}` : `下一次 ${wall(j.nextAt, TZ)}`
    const chat = chatOf(j)
    let stuck = ''
    if (!chat) stuck = '（不会触发：没有会话。删了带 chat_id 重加，或在配置里写 statusChat）'
    else if (j.nextAt && now - j.nextAt > LATE_MS) {
      const why = !rt.bridge ? '会话不在线' : S.schedulesPaused ? '「停」后暂停中，下一条新指令恢复' : '等下一轮检查'
      stuck = `（已过期 ${lateness(now - j.nextAt)}，未触发：${why}）`
    }
    return `${j.id} ${j.kind} ${when}${stuck} 会话 ${chat || '无'}：${j.text}`
  }

  function onSchedule({ action, args = {} }) {
    if (action === 'add') {
      const chat = chatFor(args.chat_id)
      const job = { id: `s${S.nextScheduleId}`, ...parseAdd(args, TZ, Date.now()), chat }
      S.nextScheduleId++
      S.schedules.push(job)
      save()
      ctx.refreshCard()
      return `已加定时 ${job.id}（会话 ${chat}），${job.nextAt ? `下一次 ${wall(job.nextAt, TZ)}（${TZ}）` : `等进程 ${job.pid} 结束`}`
    }
    if (action === 'list') {
      const now = Date.now()
      return [S.schedulesPaused ? '定时已暂停（「停」之后，下一条新指令恢复）' : '', ...S.schedules.map(j => listLine(j, now))].filter(Boolean).join('\n') || '没有定时'
    }
    if (action === 'remove') {
      const before = S.schedules.length
      S.schedules = S.schedules.filter(j => j.id !== args.id)
      if (S.schedules.length === before) throw new Error(`没有定时 ${args.id}`)
      save()
      ctx.refreshCard()
      return `已删定时 ${args.id}`
    }
    throw new Error(`未知操作：${action}`)
  }

  const startTimers = () => setInterval(tick, TICK_MS).unref()

  Object.assign(ctx, { nextSchedule, onSchedule, startTimers })
}
