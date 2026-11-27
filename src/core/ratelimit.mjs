/**
 * 按 key 的滑动窗口限流：每个 key 一分钟最多 perMinute 次、一小时最多 perHour 次。
 * take(key) 在额度够时立刻占一次；不够时等到够为止，要等的时间超过 maxWaitMs 就不等，抛错并说明多久后能发。
 * 同一个 key 的请求按到达顺序排队，不插队。
 */
export function rateLimiter({ perMinute, perHour, maxWaitMs = 60_000, label = k => `会话 ${k}`, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const hits = new Map() // key → 时间戳（升序，只留一小时内的）
  const tails = new Map() // key → 上一个排队请求的 Promise

  /** 现在离下一次能发还要等多久（毫秒）；0 = 现在就能发 */
  function wait(key, t) {
    const h = (hits.get(key) ?? []).filter(x => t - x < 3600_000)
    hits.set(key, h)
    let w = 0
    if (h.length >= perHour) w = Math.max(w, h[h.length - perHour] + 3600_000 - t)
    const lastMinute = h.filter(x => t - x < 60_000)
    if (lastMinute.length >= perMinute) w = Math.max(w, lastMinute[lastMinute.length - perMinute] + 60_000 - t)
    return w
  }

  async function run(key) {
    const w = wait(key, now())
    if (w > maxWaitMs) throw new Error(`发得太快：${label(key)} ${Math.ceil(w / 1000)} 秒后才能再发（限 ${perMinute} 次/分钟、${perHour} 次/小时）`)
    if (w > 0) await sleep(w)
    hits.get(key).push(now())
  }

  return {
    take(key) {
      const p = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => run(key))
      tails.set(key, p)
      return p
    },
  }
}
