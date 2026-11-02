import { readFileSync } from 'node:fs'

// 定时：daily / weekly 按配置时区算下一次，once 给绝对时间，不依赖系统时区。只算时间，不碰状态。
const pad = n => String(n).padStart(2, '0')

function zoned(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms))
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
}

/** 时区里的墙钟时间 → 毫秒时间戳 */
function fromWall(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const z = zoned(guess, tz)
  return guess - (Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute) - guess)
}

export function nextDaily(time, tz, after) {
  return nextWeekly(time, 0, tz, after)
}

/** weekday 1～7 是周一到周日，0 表示每天 */
export function nextWeekly(time, weekday, tz, after) {
  const [h, mi] = time.split(':').map(Number)
  const z = zoned(after, tz)
  for (let i = 0; i < 9; i++) {
    const at = fromWall(z.year, z.month, z.day + i, h, mi, tz)
    if (at <= after) continue
    const w = zoned(at, tz)
    if (!weekday || (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() || 7) === weekday) return at
  }
  throw new Error(`算不出下一次：${time}`)
}

/** 带时区的 ISO 时间，或配置时区的 YYYY-MM-DD HH:MM */
export function parseAt(at, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec((at ?? '').trim())
  if (m) return fromWall(+m[1], +m[2], +m[3], +m[4], +m[5], tz)
  return /(Z|[+-]\d{2}:?\d{2})$/.test(at ?? '') ? Date.parse(at) : NaN
}

export const next = (job, tz, after) => nextWeekly(job.time, job.kind === 'weekly' ? job.weekday : 0, tz, after)

export function wall(ms, tz) {
  const z = zoned(ms, tz)
  return `${z.year}-${pad(z.month)}-${pad(z.day)} ${pad(z.hour)}:${pad(z.minute)}`
}

/** 按 ppid 无关的 pid + 启动时刻认进程，防 pid 复用；容器重启后两者对不上，算已结束 */
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return null
  }
}

export function parseAdd(args, tz, now) {
  const { kind, time, at, text, graceMin, weekday, pid } = args
  if (!text) throw new Error('text 不能为空：写清到点做什么、看哪个文件，重开后没有上下文')
  const base = { kind, text, graceMin, createdAt: now }
  const clock = () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) throw new Error(`${kind} 要 time，格式 HH:MM`)
  }
  if (kind === 'daily') {
    clock()
    return { ...base, time, nextAt: nextDaily(time, tz, now) }
  }
  if (kind === 'weekly') {
    clock()
    if (!(weekday >= 1 && weekday <= 7)) throw new Error('weekly 要 weekday，1～7 是周一到周日')
    return { ...base, time, weekday, nextAt: nextWeekly(time, weekday, tz, now) }
  }
  if (kind === 'once') {
    const ms = parseAt(at, tz)
    if (Number.isNaN(ms)) throw new Error('once 要 at：YYYY-MM-DD HH:MM（配置时区）或带时区的 ISO 时间')
    if (ms <= now) throw new Error('at 已经过去了')
    return { ...base, nextAt: ms }
  }
  if (kind === 'process') {
    const start = procStart(pid)
    if (!start) throw new Error(`进程 ${pid} 不存在`)
    return { ...base, pid, start, nextAt: null }
  }
  throw new Error('kind 只能是 once、daily、weekly、process')
}
