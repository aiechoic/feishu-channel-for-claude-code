import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatContent, fromEvent, withRetry } from '../src/feishu.mjs'

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

test('事件转消息：内容和列表接口走同一套格式，发送者只取 open_id', () => {
  const ev = (type, content, sender) => fromEvent({
    message: { message_id: 'om_1', message_type: type, content: JSON.stringify(content), create_time: '1793669650874' },
    sender,
  })
  const bot = { sender_id: { open_id: 'ou_bot', user_id: null }, sender_type: 'bot' }
  const m = ev('text', { text: '@_user_1 你好' }, bot)
  assert.equal(m.content, '@_user_1 你好')
  assert.equal(m.msg_type, 'text')
  assert.equal(m.create_ms, 1793669650874)
  assert.deepEqual(m.sender, { id: 'ou_bot', sender_type: 'bot', name: '' })
  assert.equal(ev('image', { image_key: 'img_1' }, bot).content, '[Image: img_1]')
  assert.equal(ev('file', { file_key: 'f_1', file_name: 'a.txt' }, bot).content, '<file key="f_1" name="a.txt"/>')
  assert.equal(ev('post', { title: '标题', content: [[{ tag: 'text', text: '正文' }]] }, bot).content, '标题\n正文')
  assert.equal(ev('text', { text: 'x' }, undefined).sender.id, '')
})
