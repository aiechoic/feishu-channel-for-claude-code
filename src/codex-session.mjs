import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { channelInput } from './codex-rpc.mjs'

export const deliveryKey = m => createHash('sha256').update(JSON.stringify([m.meta.chat_id, m.meta.message_id, m.content])).digest('hex')

/** Serial acceptance, stop barrier, and lifecycle translation, independent of the transport. */
export class CodexSession extends EventEmitter {
  constructor(rpc, threadId, accepted = []) {
    super()
    this.rpc = rpc
    this.threadId = threadId
    this.accepted = new Set(accepted)
    this.turnId = null
    this.stopped = false
    this.serial = Promise.resolve()
    rpc.on('notification', m => this.onNotification(m))
  }
  hook(event, extra = {}) { this.emit('hook', { t: 'hook', event, ...extra }) }
  onNotification({ method, params: p }) {
    if (p?.threadId !== this.threadId) return
    if (method === 'turn/started') {
      this.turnId = p.turn.id
      if (this.stopped) { this.interrupt().catch(e => this.emit('failure', e)); return }
      this.hook('UserPromptSubmit')
    } else if (method === 'turn/completed') {
      this.turnId = null
      this.stopped = false
      this.hook('Stop')
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item
      if (!['commandExecution', 'mcpToolCall', 'fileChange', 'dynamicToolCall'].includes(item?.type)) return
      if (this.stopped) { this.interrupt().catch(e => this.emit('failure', e)); return }
      this.hook(method === 'item/started' ? 'PreToolUse' : 'PostToolUse', { tool: item.type, toolUseId: item.id })
    }
  }
  accept(m) {
    const task = this.serial.then(async () => {
      const key = deliveryKey(m)
      if (this.accepted.has(key)) return key
      if (this.stopped) throw new Error('停止中，保留消息等待本轮结束')
      const input = channelInput(m, key)
      // Read current state instead of assuming the turn is still running after a notification.
      const { thread } = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true })
      if (thread.turns?.some(t => t.items?.some(i => i.type === 'userMessage' && i.content?.some(c => c.type === 'text' && c.text.includes(`[feishu-delivery:${key}]`))))) {
        this.accepted.add(key)
        this.emit('accepted', key)
        return key
      }
      const active = thread.turns?.findLast(t => t.status === 'inProgress')
      if (this.stopped) throw new Error('停止中，未送出')
      if (active) {
        this.turnId = active.id
        await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: active.id, input, clientUserMessageId: `feishu:${key}` })
      } else {
        const result = await this.rpc.request('turn/start', { threadId: this.threadId, input, clientUserMessageId: `feishu:${key}` })
        this.turnId = result.turn.id
      }
      this.accepted.add(key)
      this.emit('accepted', key)
      return key
    })
    this.serial = task.catch(() => {})
    return task
  }
  async interrupt() {
    this.stopped = true
    if (this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
  }
}
