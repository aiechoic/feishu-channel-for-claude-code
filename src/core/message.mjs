// 适配器共用：消息结构里的时间。消息结构 { message_id, msg_type, content, create_time, create_ms, deleted, sender: { id, sender_type, name } }，
// create_time 是给模型看的本地时间（年-月-日 时:分），create_ms 是毫秒时间戳。

/** 毫秒时间戳 → 年-月-日 时:分（本机时区） */
export const stamp = ms => {
  const d = new Date(Number(ms))
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 平台给的时间：秒或毫秒都认；没有或不对时用现在 */
export const toMs = t => {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 1e12 ? n * 1000 : n
}
