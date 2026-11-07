// 模拟协议对端，提供确定的生命周期事件，不调用模型。
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
let active = null, sequence = 0
const send = m => console.log(JSON.stringify(m))
const notify = (method, params) => send({ method, params: { threadId: 'thread_example', ...params } })
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  appendFileSync(`${process.env.FAKE}/codex.log`, JSON.stringify(m) + '\n')
  let result = {}
  if (m.method === 'thread/start' || m.method === 'thread/resume') result = { thread: { id: 'thread_example' } }
  if (m.method === 'thread/read') result = { thread: { turns: active ? [{ id: active, status: 'inProgress' }] : [] } }
  if (m.method === 'turn/start') {
    active = `turn_${++sequence}`
    result = { turn: { id: active } }
    // 先通知再响应，覆盖与 daemon 唤醒确认之间的时序。
    notify('turn/started', { turn: { id: active } })
  }
  send({ id: m.id, result })
  if (m.method === 'turn/interrupt') {
    notify('turn/completed', { turn: { id: active, status: 'interrupted' } })
    active = null
  }
  if (m.method === 'turn/start' && JSON.stringify(m.params.input).includes('撤回')) {
    const turn = active
    setTimeout(() => {
      if (active !== turn) return
      notify('turn/completed', { turn: { id: turn, status: 'completed' } })
      active = null
    }, 100)
  }
})
