// 限流：按 key 的分钟 / 小时窗口，超了排队等，要等太久就报错；同一个 key 按顺序
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rateLimiter } from '../src/core/ratelimit.mjs'

/** 假时钟：sleep 直接把时间往前拨 */
function clock() {
  let t = 1_000_000
  return { now: () => t, sleep: async ms => { t += ms }, advance: ms => { t += ms } }
}

test('限流：一分钟内超过 perMinute 就等到最早那次过一分钟；不同 key 互不影响', async () => {
  const c = clock()
  const rl = rateLimiter({ perMinute: 2, perHour: 100, now: c.now, sleep: c.sleep })
  await rl.take('a')
  c.advance(10_000)
  await rl.take('a')
  const before = c.now()
  await rl.take('b')
  assert.equal(c.now(), before, '别的 key 不等')
  await rl.take('a')
  assert.equal(c.now(), before + 50_000, '等到第一次满一分钟')
})

test('限流：要等的时间超过 maxWaitMs 就报错，不占额度；小时上限也算', async () => {
  const c = clock()
  const rl = rateLimiter({ perMinute: 100, perHour: 3, maxWaitMs: 60_000, now: c.now, sleep: c.sleep })
  for (let i = 0; i < 3; i++) { await rl.take('a'); c.advance(1000) }
  await assert.rejects(() => rl.take('a'), /秒后才能再发/)
  c.advance(3600_000)
  await rl.take('a')
})

test('限流：同一个 key 并发调用按到达顺序依次放行；前一个报错不卡住后面的', async () => {
  const c = clock()
  const rl = rateLimiter({ perMinute: 1, perHour: 100, maxWaitMs: 60_000, now: c.now, sleep: c.sleep })
  const order = []
  await Promise.allSettled([1, 2, 3].map(i => rl.take('a').then(() => order.push([i, c.now()]), () => order.push([i, 'err']))))
  assert.deepEqual(order.map(x => x[0]), [1, 2, 3])
  assert.equal(order[1][1] - order[0][1], 60_000)
  assert.equal(order[2][1] - order[1][1], 60_000)
})

test('outbox：平台限额 + 配置覆盖；会话和应用两层都要有额度；上传单独一个桶', async () => {
  const { outbox, limitsOf } = await import('../src/core/outbox.mjs')
  const l = limitsOf({ chat: { perMinute: 60, perHour: 900 }, app: { perMinute: 3, perHour: 100 } }, { perMinute: 2, maxWaitSec: 1 })
  assert.deepEqual([l.chat, l.app, l.upload.perMinute, l.maxWaitMs], [{ perMinute: 2, perHour: 900 }, { perMinute: 3, perHour: 100 }, Infinity, 1000])
  const c = clock()
  const box = outbox(l, { now: c.now, sleep: c.sleep })
  const sent = []
  await box.send('a', () => sent.push('a1'))
  await box.send('a', () => sent.push('a2'))
  await assert.rejects(() => box.send('a', () => sent.push('a3')), /会话 a .*秒后才能再发/)
  await box.send('b', () => sent.push('b1'))
  await assert.rejects(() => box.send('c', () => sent.push('c1')), /整个机器人/)
  for (let i = 0; i < 5; i++) await box.upload(() => sent.push(`u${i}`))
  assert.deepEqual(sent, ['a1', 'a2', 'b1', 'u0', 'u1', 'u2', 'u3', 'u4'])
})
