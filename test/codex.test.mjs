import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { CodexSession, deliveryKey } from '../src/codex-session.mjs'
import { channelInput } from '../src/codex-rpc.mjs'

class FakeRpc extends EventEmitter {
  calls = []
  active = null
  fail = false
  async request(method, params) {
    this.calls.push({ method, params })
    if (this.fail) throw new Error('offline')
    if (method === 'thread/read') return { thread: { turns: this.active ? [{ id: this.active, status: 'inProgress' }] : [] } }
    if (method === 'turn/start') { this.active = 'turn1'; return { turn: { id: this.active } } }
    return {}
  }
}
const message = (content = 'one') => ({ pushId: 'p1', content, meta: { chat_id: 'oc_example', message_id: 'om_example' } })

test('压缩拒绝保留投递，轮次结束后启动一次并去重', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  rpc.active = 'compact'
  const request = rpc.request.bind(rpc)
  let rejected = false, persisted = 0
  s.on('accepted', () => persisted++)
  rpc.request = async (method, params) => {
    if (method === 'turn/steer') {
      rpc.calls.push({ method, params })
      rejected = true
      assert.equal(s.accepted.size, 0)
      rpc.active = null
      throw new Error('cannot steer a compact turn')
    }
    return request(method, params)
  }
  await s.accept(message())
  assert.ok(rejected)
  assert.equal(persisted, 1)
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 1)
  await s.accept(message())
  assert.equal(persisted, 1)
})

test('压缩结束仍有活动轮次时重新读取并 steer，后续消息保持串行', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  rpc.active = 'compact'
  const request = rpc.request.bind(rpc)
  let attempts = 0
  rpc.request = async (method, params) => {
    if (method === 'turn/steer' && attempts++ === 0) {
      rpc.calls.push({ method, params })
      rpc.active = 'normal'
      throw new Error('cannot steer a compact turn')
    }
    return request(method, params)
  }
  await Promise.all([s.accept(message()), s.accept(message('two'))])
  const steers = rpc.calls.filter(c => c.method === 'turn/steer')
  assert.deepEqual(steers.map(c => c.params.expectedTurnId), ['compact', 'normal', 'normal'])
  assert.equal(s.accepted.size, 2)
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 0)
})

test('投递超时不自动重试、不确认', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  rpc.active = 'normal'
  const request = rpc.request.bind(rpc)
  rpc.request = async (method, params) => {
    if (method === 'turn/steer') throw new Error('RPC timeout: turn/steer; delivery uncertain')
    return request(method, params)
  }
  await assert.rejects(s.accept(message()), /delivery uncertain/)
  assert.equal(s.accepted.size, 0)
  assert.equal(rpc.calls.length, 1)
})

test('压缩重试遇到停止屏障时等待完成，不越过屏障投递', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  rpc.active = 'compact'
  const request = rpc.request.bind(rpc)
  let complete
  rpc.request = async (method, params) => {
    if (method === 'turn/steer') {
      s.stopped = true
      complete = setTimeout(() => {
        assert.equal(s.accepted.size, 0)
        rpc.active = null
        rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread1', turn: { id: 'compact' } } })
      }, 1200)
      throw new Error('cannot steer a compact turn')
    }
    return request(method, params)
  }
  try { await s.accept(message()) } finally { clearTimeout(complete) }
  assert.equal(s.accepted.size, 1)
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, 1)
})

test('压缩等待后历史已有投递标记时仅确认，不再次发送', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1'), m = message()
  let reads = 0, steers = 0
  rpc.request = async method => {
    if (method === 'thread/read') {
      reads++
      return { thread: { turns: reads === 1 ? [{ id: 'compact', status: 'inProgress' }] : [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: `[feishu-delivery:${deliveryKey(m)}]` }] }] }] } }
    }
    assert.equal(method, 'turn/steer')
    steers++
    throw new Error('cannot steer a compact turn')
  }
  await s.accept(m)
  assert.equal(steers, 1)
  assert.equal(reads, 2)
  assert.equal(s.accepted.size, 1)
})

test('idle starts, busy steers with active-turn precondition, accepted messages deduplicate across retries', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  await s.accept(message())
  assert.equal(rpc.calls.at(-1).method, 'turn/start')
  await s.accept({ ...message(), pushId: 'retry' })
  assert.equal(rpc.calls.length, 2)
  await s.accept(message('two'))
  assert.equal(rpc.calls.at(-1).method, 'turn/steer')
  assert.equal(rpc.calls.at(-1).params.expectedTurnId, 'turn1')
  const restarted = new CodexSession(rpc, 'thread1', [...s.accepted])
  const before = rpc.calls.length
  await restarted.accept(message())
  assert.equal(rpc.calls.length, before)
})
test('failure does not acknowledge, stop barrier prevents later delivery, completion resumes', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  rpc.fail = true
  await assert.rejects(s.accept(message()), /offline/)
  assert.equal(s.accepted.size, 0)
  rpc.fail = false
  await s.accept(message())
  await s.interrupt()
  assert.deepEqual(rpc.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread1', turnId: 'turn1' } })
  await assert.rejects(s.accept(message('next')), /停止中/)
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread1', turn: { id: 'turn1' } } })
  assert.equal(s.stopped, false)
})
test('events for other threads ignored; tools map lifecycle and stopped tools request interrupt', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1'), hooks = []
  s.on('hook', h => hooks.push(h))
  rpc.emit('notification', { method: 'turn/started', params: { threadId: 'other', turn: { id: 'bad' } } })
  assert.equal(hooks.length, 0)
  rpc.emit('notification', { method: 'turn/started', params: { threadId: 'thread1', turn: { id: 'turn1' } } })
  rpc.emit('notification', { method: 'item/started', params: { threadId: 'thread1', item: { id: 'tool1', type: 'commandExecution' } } })
  assert.deepEqual(hooks.map(h => h.event), ['UserPromptSubmit', 'PreToolUse'])
  await s.interrupt()
  const before = hooks.length
  rpc.emit('notification', { method: 'item/started', params: { threadId: 'thread1', item: { id: 'tool2', type: 'commandExecution' } } })
  await Promise.resolve()
  assert.equal(hooks.length, before)
  assert.equal(rpc.calls.at(-1).method, 'turn/interrupt')
})
test('merged metadata and source are preserved; schedule contents have distinct deduplication keys', () => {
  const m = message('[om_a]\na\n[om_b]\nb\n[om_c]\nc')
  m.meta.message_id = 'om_a,om_b,om_c'
  assert.match(channelInput(m)[0].text, /om_a,om_b,om_c/)
  assert.notEqual(deliveryKey(message('schedule one')), deliveryKey(message('schedule two')))
  assert.match(channelInput({ ...m, meta: { ...m.meta, trust: 'external' } })[0].text, /不授权执行/)
})
test('history marker recovers accepted delivery after local acknowledgement file is lost', async () => {
  const rpc = new FakeRpc(), m = message(), key = deliveryKey(m)
  rpc.request = async method => {
    assert.equal(method, 'thread/read')
    return { thread: { turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: `[feishu-delivery:${key}]` }] }] }] } }
  }
  const s = new CodexSession(rpc, 'thread1')
  await s.accept(m)
  assert.ok(s.accepted.has(key))
})
test('matching completion confirms stop even when interrupt RPC later times out', async () => {
  const rpc = new FakeRpc(), s = new CodexSession(rpc, 'thread1')
  s.turnId = 'turn1'
  let rejectRpc
  rpc.request = () => new Promise((resolve, reject) => { rejectRpc = reject })
  const stopped = s.interrupt()
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'thread1', turn: { id: 'turn1', status: 'interrupted' } } })
  await stopped
  rejectRpc(new Error('RPC timeout'))
  await Promise.resolve()
  assert.equal(s.turnId, null)
  assert.equal(s.listenerCount('turn-finished'), 0)
})
