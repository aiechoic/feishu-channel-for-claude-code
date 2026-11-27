// 定时：到点进同一条队列；会话不在线或「停」之后不触发，等恢复后再判宽限期，过了宽限期只回报跳过。
import { next, parseAdd, procStart, wall } from '../schedule.mjs'

const LATE_MS = 60_000

function lateness(ms) {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`
}

export function install(ctx) {
  const { cfg, S, save, log, rt, TZ } = ctx
  const GRACE_MIN = { once: cfg.onceGraceMin ?? 10_080, daily: cfg.repeatGraceMin ?? 720, weekly: cfg.repeatGraceMin ?? 720 }
  const TICK_MS = (cfg.scheduleTickSec ?? 15) * 1000

  function nextSchedule() {
    return S.schedules.filter(j => j.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0]
  }

  function fire(job, chat, label) {
    ctx.enqueue({ notice: true, label: `定时 ${job.id}`, scheduleId: job.id, chat, content: `[定时 ${job.id}]${label} ${job.text}` })
    log(`定时 ${job.id} 触发`)
  }

  function tick() {
    const chat = cfg.statusChat
    if (!rt.bridge || !chat || S.schedulesPaused) return
    const now = Date.now()
    for (const job of [...S.schedules]) {
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

  function onSchedule({ action, args = {} }) {
    if (action === 'add') {
      const job = { id: `s${S.nextScheduleId++}`, ...parseAdd(args, TZ, Date.now()) }
      S.schedules.push(job)
      save()
      ctx.refreshCard()
      return `已加定时 ${job.id}，${job.nextAt ? `下一次 ${wall(job.nextAt, TZ)}（${TZ}）` : `等进程 ${job.pid} 结束`}`
    }
    if (action === 'list') {
      const when = j => (j.kind === 'process' ? `等进程 ${j.pid}` : `下一次 ${wall(j.nextAt, TZ)}`)
      return [S.schedulesPaused ? '定时已暂停（「停」之后，下一条新指令恢复）' : '', ...S.schedules.map(j => `${j.id} ${j.kind} ${when(j)}：${j.text}`)].filter(Boolean).join('\n') || '没有定时'
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
