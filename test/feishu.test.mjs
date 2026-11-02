import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatContent, withRetry } from '../src/feishu.mjs'

test('网络错误重试，飞书业务错误不重试', async () => {
  let n = 0
  assert.equal(await withRetry(async () => {
    if (++n < 3) throw new Error('EOF')
    return 'ok'
  }, { waitMs: 1 }), 'ok')
  n = 0
  await assert.rejects(withRetry(async () => {
    n++
    throw Object.assign(new Error('无权限'), { feishuCode: 99991672 })
  }, { waitMs: 1 }))
  assert.equal(n, 1)
})

test('消息内容转文本', () => {
  assert.equal(formatContent('text', '{"text":"停"}'), '停')
  assert.equal(formatContent('image', '{"image_key":"k"}'), '[Image: k]')
  assert.equal(formatContent('post', '{"title":"t","content":[[{"tag":"a","text":"x","href":"u.example"}]]}'), 't\n[x](u.example)')
})
