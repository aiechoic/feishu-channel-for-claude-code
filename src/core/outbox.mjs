/**
 * 发送出口：所有往 IM 发东西的动作（reply、send_file、「停」的回执、状态卡片）都从这里过，按限额排队。
 * 平台只给限额（适配器的 limits），真正的发送函数由调用方传进来；平台无关。
 *
 * 限额分三个桶，都是滑动窗口（rateLimiter）：
 *   chat    每个会话：perMinute / perHour
 *   app     整个机器人 / 应用的发送总量
 *   upload  上传附件（只在发文件时用）
 * 配置 cfg.rateLimit 可以覆盖：{ perMinute, perHour, appPerMinute, appPerHour, uploadPerMinute, uploadPerHour, maxWaitSec }。
 * 额度不够就排队等；要等超过 maxWaitSec（默认 60 秒）就不等，抛错说明多久后能发，调用方原样告诉会话。
 */
import { rateLimiter } from './ratelimit.mjs'

const NONE = { perMinute: Infinity, perHour: Infinity }

/** 适配器的默认限额 + 配置覆盖 → 三个桶的限额 */
export function limitsOf(platformLimits = {}, override = {}) {
  const pick = (base = NONE, m, h) => ({ perMinute: override[m] ?? base.perMinute ?? Infinity, perHour: override[h] ?? base.perHour ?? Infinity })
  return {
    chat: pick(platformLimits.chat, 'perMinute', 'perHour'),
    app: pick(platformLimits.app, 'appPerMinute', 'appPerHour'),
    upload: pick(platformLimits.upload, 'uploadPerMinute', 'uploadPerHour'),
    maxWaitMs: (override.maxWaitSec ?? 60) * 1000,
  }
}

export function outbox(limits, clock = {}) {
  const make = (l, label) => rateLimiter({ ...l, maxWaitMs: limits.maxWaitMs, label, ...clock })
  const chat = make(limits.chat, k => `会话 ${k}`)
  const app = make(limits.app, () => '整个机器人')
  const upload = make(limits.upload, () => '上传附件')
  return {
    limits,
    /** 往 chat 发一条：先占会话额度，再占应用额度，然后调 fn */
    async send(chatId, fn) {
      await chat.take(chatId)
      await app.take('app')
      return fn()
    },
    /** 上传一个附件 */
    async upload(fn) {
      await upload.take('upload')
      return fn()
    },
  }
}
