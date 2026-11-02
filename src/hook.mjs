#!/usr/bin/env node
/**
 * Claude Code hook：把忙闲事件报给常驻进程；PreToolUse 时看到停止标记就结束这一轮。
 * 只上报事件名和工具名，不上报工具入参。常驻进程不在时静默跳过，不影响会话。
 */
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { paths, readConfig } from './common.mjs'

const { sock, stopFlag } = paths(readConfig())
let raw = ''
for await (const chunk of process.stdin) raw += chunk
const hook = JSON.parse(raw || '{}')
const event = hook.hook_event_name ?? ''
const stopped = event === 'PreToolUse' && existsSync(stopFlag)

await new Promise(resolve => {
  const c = connect(sock)
  const done = () => { c.destroy(); resolve() }
  c.setTimeout(500, done)
  c.on('error', done)
  c.on('connect', () => c.end(`${JSON.stringify({
    t: 'hook',
    event,
    tool: hook.tool_name ?? '',
    toolUseId: hook.tool_use_id ?? '',
    background: hook.tool_input?.run_in_background === true,
    blocked: stopped,
  })}\n`, done))
})

// continue:false 只结束这一轮，这次工具调用还要靠 deny 拦住
const reason = '飞书收到「停」，这一轮结束'
if (stopped) {
  console.log(JSON.stringify({
    continue: false,
    stopReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }))
}
