import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkScopes, report } from '../src/doctor.mjs'

test('按功能报缺失和影响，im:message 一项覆盖多数功能', () => {
  const r = checkScopes(['im:message', 'im:chat', 'im:message.group_msg', 'im:message.p2p_msg:readonly'])
  assert.equal(r.missing.length, 0)
  const q = checkScopes(['im:chat', 'im:message:readonly', 'im:message:send_as_bot', 'im:message.p2p_msg:readonly'])
  assert.deepEqual(q.coreMissing, [])
  assert.ok(q.missing.some(n => n.feature === '收群里全部消息'))
  assert.match(report(q), /缺 加表情.*影响：/)
  assert.equal(checkScopes([]).coreMissing.length, 4)
})

test('对比部署清单，报多了和少了；提示事件无法自动检查', () => {
  const r = checkScopes(['a', 'b'], ['b', 'c'])
  assert.deepEqual(r.extra, ['a'])
  assert.deepEqual(r.absent, ['c'])
  const text = report(r, ['b', 'c'])
  assert.match(text, /少了 c/)
  assert.match(text, /多了 a/)
  assert.match(text, /事件订阅无法自动检查/)
  assert.match(text, /im\.message\.recalled_v1/)
})
