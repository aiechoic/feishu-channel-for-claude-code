import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextWeekly, parseAt, wall } from '../src/schedule.mjs'

const BJ = 'Asia/Shanghai'

test('北京时间绝对时间不受系统时区影响', () => {
  const ms = parseAt('2026-11-03 09:00', BJ)
  assert.equal(new Date(ms).toISOString(), '2026-11-03T01:00:00.000Z')
  assert.equal(wall(ms, BJ), '2026-11-03 09:00')
  assert.equal(parseAt('2026-11-03T09:00:00+08:00', BJ), ms)
  assert.ok(Number.isNaN(parseAt('2026-11-03T09:00:00', BJ)))
})

test('每天和每周一算到北京时间的下一次', () => {
  const now = Date.parse('2026-11-02T02:00:00Z') // 周一 10:00
  assert.equal(wall(nextWeekly('09:00', 0, BJ, now), BJ), '2026-11-03 09:00')
  assert.equal(wall(nextWeekly('11:00', 0, BJ, now), BJ), '2026-11-02 11:00')
  assert.equal(wall(nextWeekly('09:00', 1, BJ, now), BJ), '2026-11-09 09:00')
  assert.equal(wall(nextWeekly('11:00', 1, BJ, now), BJ), '2026-11-02 11:00')
})
