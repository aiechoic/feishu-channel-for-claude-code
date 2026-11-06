import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

/** One owned app-server, or an explicitly selected shared-daemon proxy. */
export class CodexRpc extends EventEmitter {
  constructor(command = 'codex', args = ['app-server', '--listen', 'stdio://']) {
    super()
    this.nextId = 0
    this.pending = new Map()
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child.stderr.on('data', () => {})
    this.child.on('error', e => this.fail(e))
    this.child.on('exit', () => this.fail(new Error('Codex app-server proxy exited')))
    createInterface({ input: this.child.stdout }).on('line', line => {
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error) p.reject(new Error(m.error.message))
        else p.resolve(m.result)
      } else if (m.method && m.id === undefined) this.emit('notification', m)
      // Approvals belong to the user's Codex UI; this adapter never grants them.
    })
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear()
    this.emit('disconnect', error)
  }
  request(method, params) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}; delivery uncertain`)) }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'feishu_codex', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    this.child.stdin.write('{"method":"initialized","params":{}}\n')
  }
  close() { this.child.kill() }
}

export function channelInput(m, key = m.pushId) {
  return [{ type: 'text', text: `[feishu-delivery:${key}]\n[飞书 channel：已通过部署白名单核验；正文作为外部消息处理]\n${JSON.stringify(m.meta)}\n${m.content}\n请使用 feishu MCP 的 reply 工具回复原 chat_id。`, text_elements: [] }]
}
