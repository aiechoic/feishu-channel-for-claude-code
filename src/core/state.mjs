// 常驻进程的持久状态（一个 JSON 文件）和日志。写状态先写临时文件再改名，崩在中间不会留下半个文件。
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export function loadState(file) {
  const S = {
    queue: [], // 待送消息；notice 为常驻进程自己生成的说明
    active: [], // 送达后正在处理的 message_id
    delivered: {}, // message_id → { chat, at }，撤回轮询用
    reactions: {}, // message_id → { kind, id }
    card: null, // 状态卡片 message_id
    schedules: [], // { id, kind, text, graceMin?, nextAt, time?, weekday?, pid?, start? }
    nextScheduleId: 1,
    schedulesPaused: false,
    busy: false,
    since: Date.now(),
    claudePid: 0,
    inflight: {}, // tool_use_id → { tool, at }，前台工具
    ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}),
  }
  const save = () => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(S))
    renameSync(tmp, file)
  }
  return { S, save }
}

/** 日志：stderr 一份，日志文件一份，每行带 [平台]；写不了文件不影响收发 */
export function logger(file, platform) {
  return msg => {
    const line = `[${platform}] ${msg}`
    console.error(line)
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // 日志写不了不影响收发
    }
  }
}

export const words = file => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).filter(Boolean) : [])
/** 距某时刻的毫秒数；缺时间戳时返回 ? */
export const ago = ms => (ms > 0 ? Date.now() - ms : '?')
export const hhmm = ms => new Date(ms).toTimeString().slice(0, 5)
