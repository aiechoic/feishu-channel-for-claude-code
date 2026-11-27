// 本机端点：桥（bridge.mjs）和 hook（hook.mjs）连进来的 Unix socket / Windows 命名管道，一行一个 JSON。
// 桥：hello 报会话、ack 确认送达、tools / call 取工具和调工具（工具定义和执行都在常驻进程这边，见 tools.mjs）。
import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { callTool, toolsFor } from '../tools.mjs'

export function install(ctx) {
  const { P, S, log, PLATFORM, rt } = ctx
  const TOOLS = toolsFor(PLATFORM)
  const TOOL_OPS = {
    send: (...a) => ctx.send(...a),
    sendFile: (...a) => ctx.sendFile(...a),
    readUnread: a => ctx.readUnread(a),
    schedule: (action, args) => ctx.onSchedule({ action, args }),
  }
  const write = (sock, m) => sock.write(`${JSON.stringify(m)}\n`)
  rt.bridge = null // { sock, claudePid, bridgePid }

  function onLine(sock, line) {
    const m = JSON.parse(line)
    if (m.t === 'hook') ctx.onHook(m)
    else if (m.t === 'ack') ctx.onAck(m.pushId)
    else if (m.t === 'hello') {
      rt.bridge = { sock, claudePid: m.claudePid, bridgePid: m.bridgePid }
      log(`桥已连上：claude ${m.claudePid}`)
      setTimeout(ctx.kickNotice, 0)
      if (S.claudePid === m.claudePid) { // 同一会话重连，忙闲沿用
        ctx.refreshCard()
        ctx.deliver()
      } else {
        S.claudePid = m.claudePid
        ctx.resumeWake()
        rt.wakeTries = 0
        ctx.setIdle('新会话', false)
      }
    } else if (m.t === 'tools') { // 桥连上后取工具列表，常驻进程换版后桥据此通知客户端
      write(sock, { t: 'tools-result', id: m.id, tools: TOOLS })
    } else if (m.t === 'call') {
      callTool(TOOL_OPS, m.name, m.args ?? {}, PLATFORM).then(result => write(sock, { t: 'call-result', id: m.id, result }))
    } else if (m.t === 'reply' || m.t === 'schedule' || m.t === 'unread') { // 旧版桥：工具写死在桥里，按旧消息格式答
      const name = m.t === 'reply' ? 'reply' : m.t === 'unread' ? 'read_unread' : `schedule_${m.action}`
      const args = m.t === 'reply' ? { chat_id: m.chat_id, text: m.text } : m.args ?? {}
      callTool(TOOL_OPS, name, args, PLATFORM).then(r => write(sock, { t: 'reply-result', id: m.id, ok: !r.isError, text: r.content[0].text }))
    }
  }

  /** 建端点（还没 listen） */
  function makeServer() {
    if (!P.pipe) rmSync(P.sock, { force: true }) // Unix socket 文件会残留；Windows 命名管道随进程消失
    return createServer(sock => {
      sock.on('error', () => {})
      createInterface({ input: sock }).on('error', () => {}).on('line', line => {
        try {
          onLine(sock, line)
        } catch (e) {
          log(`本地消息处理失败：${e.message}`)
        }
      })
      sock.on('close', () => {
        if (rt.bridge?.sock !== sock) return
        rt.bridge = null
        rt.pushing = null
        if (rt.waking) ctx.notWoken()
        log('桥断开，会话离线')
        S.claudePid = 0
        ctx.setIdle('会话离线', false)
      })
    })
  }

  Object.assign(ctx, { makeServer })
}
