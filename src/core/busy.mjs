// 忙闲：hook.mjs 上报。PreToolUse 之后还没等到同一 tool_use_id 的 PostToolUse / PostToolUseFailure 时算忙（等用户回答、等权限确认也是），
// 心跳超时不判闲；没配对的 PreToolUse 由 Stop、UserPromptSubmit 清掉，超过 toolWaitMaxSec 也不再算数。
// 忙且心跳超时、没有等着的工具、也没有活着的工具进程时按闲处理。
import { existsSync, rmSync } from 'node:fs'
import proc, { COMMAND_TOOLS, isCommandShell } from '../proc.mjs'

export function install(ctx) {
  const { cfg, P, S, save, log, rt } = ctx
  const BUSY_TIMEOUT_MS = (cfg.busyTimeoutSec ?? 180) * 1000
  const TOOL_WAIT_MAX_MS = (cfg.toolWaitMaxSec ?? 86_400) * 1000
  let beat = Date.now()

  function setBusy(why) {
    beat = Date.now()
    if (S.busy) return
    S.busy = true
    S.since = Date.now()
    log(`标忙：${why}`)
    save()
    ctx.refreshCard()
  }

  function setIdle(why, finished) {
    rmSync(P.stopFlag, { force: true })
    rt.plainInjected = 0
    S.inflight = {}
    rt.tool = ''
    if (S.busy) {
      S.busy = false
      S.since = Date.now()
      log(`标闲：${why}`)
    }
    if (finished) S.active.forEach(id => ctx.react(id, 'done'))
    S.active = []
    save()
    ctx.refreshCard()
    ctx.deliver()
  }

  /** 新一轮开始时上一轮没配对的 PreToolUse（丢了 Post 的工具）不再算忙 */
  function dropUnpaired(why) {
    const left = Object.values(S.inflight)
    if (!left.length) return
    log(`${why}：清掉 ${left.length} 个没等到 PostToolUse 的工具 ${left.map(t => t.tool).join(' ')}`)
    S.inflight = {}
    rt.tool = ''
  }

  function onHook(h) {
    log(`hook ${h.event}${h.tool ? ` ${h.tool}` : ''}${h.blocked ? '（已拦）' : ''}`)
    const resumed = ctx.resumeWake()
    const systemWake = rt.waking?.batch.every(m => m.notice || m.external) // 系统说明、定时、外部发送者唤醒的一轮不算新指令
    ctx.woke() // 只在闲时送出，送出后的任何 hook 都说明会话收到了
    switch (h.event) {
      case 'UserPromptSubmit':
        // 停止标记在、会话还忙：是「停」或撤回打断之前忙时送出的补充这时才进会话，不算新指令，标记留着让这一轮结束
        if (S.busy && existsSync(P.stopFlag)) {
          dropUnpaired(h.event)
          setBusy(h.event)
          break
        }
        // 忙时送进去的只有外部发送者的消息或说明时，这次 UserPromptSubmit 是它们触发的，也不算新指令
        if (!systemWake && !(S.busy && rt.plainInjected)) S.schedulesPaused = false
        rt.plainInjected = 0
        dropUnpaired(h.event)
        rmSync(P.stopFlag, { force: true })
        setBusy(h.event)
        ctx.deliver() // 停止标记清掉了，等着的消息可以忙时送
        break
      case 'PreToolUse':
        setBusy(h.event)
        if (h.blocked) {
          setTimeout(() => S.busy && existsSync(P.stopFlag) && setIdle('停止标记拦下', false), 3000)
          break
        }
        rt.tool = h.tool
        if (!h.background) S.inflight[h.toolUseId] = { tool: h.tool, at: Date.now() }
        save()
        ctx.refreshCard()
        break
      case 'PostToolUse':
      case 'PostToolUseFailure':
        beat = Date.now()
        delete S.inflight[h.toolUseId]
        rt.tool = Object.values(S.inflight).at(-1)?.tool ?? ''
        save()
        ctx.refreshCard()
        break
      case 'Stop':
        setIdle(h.event, true)
        break
    }
    if (resumed) ctx.deliver()
  }

  /** 当前前台命令工具（Bash / PowerShell）的进程：Claude Code 的子 shell 里，开始时间不早于那次 PreToolUse 的最新一个 */
  function toolProcess() {
    const started = Object.values(S.inflight).filter(t => COMMAND_TOOLS.has(t.tool)).map(t => t.at)
    if (!rt.bridge || !started.length) return null
    const after = Math.min(...started) - 2000
    const shells = proc.children(rt.bridge.claudePid).filter(p => p.pid !== rt.bridge.bridgePid
      && isCommandShell(p) && p.startMs >= after && !p.cmd.includes('hook.mjs'))
    return shells.sort((a, b) => b.startMs - a.startMs)[0]?.pid ?? null
  }

  function killTree(root) {
    log(`已杀工具进程树 ${proc.killTree(root).join(' ')}`)
  }

  /** 还在等结果的前台工具（PreToolUse 之后没有 Post）；超过 toolWaitMaxSec 的当作丢了 Post，不算 */
  function waitingTools() {
    const now = Date.now()
    return Object.values(S.inflight).filter(t => now - t.at < TOOL_WAIT_MAX_MS)
  }

  let holding = '' // 心跳超时但因等着的工具没判闲时记一次日志
  function watchdog() {
    if (!S.busy || Date.now() - beat < BUSY_TIMEOUT_MS) return
    const waiting = waitingTools()
    if (waiting.length) {
      const what = waiting.map(t => t.tool).join(' ')
      if (holding !== what) log(`心跳超时，但工具 ${what} 还没结束（等用户回答或权限确认），仍按忙`)
      holding = what
      return
    }
    holding = ''
    if (toolProcess()) {
      beat = Date.now()
      return
    }
    setIdle('心跳超时', false)
  }

  /** 写停止标记拦下工具调用，杀当前工具进程；返回杀了没有 */
  function interrupt(why) {
    if (!S.busy) return false
    ctx.writeStopFlag(why)
    const pid = toolProcess()
    if (pid) killTree(pid)
    return Boolean(pid)
  }

  Object.assign(ctx, { setBusy, setIdle, onHook, watchdog, interrupt })
}
