// A protocol peer, not a model: deterministic lifecycle events for the owned app-server adapter.
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
    // Deliberately notify before response to cover ordering against daemon wake acknowledgement.
    notify('turn/started', { turn: { id: active } })
  }
  send({ id: m.id, result })
  if (m.method === 'turn/interrupt') {
    notify('turn/completed', { turn: { id: active, status: 'interrupted' } })
    active = null
  }
})
