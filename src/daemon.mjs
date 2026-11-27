#!/usr/bin/env node
/**
 * channel 常驻进程：持有事件长连接、已读记录、消息队列、定时和忙闲状态，由 supervise.mjs 负责重启。
 * 这里只做组装：读配置、接适配器、建共用的 ctx，再把各模块装上去。模块之间互相调用都经 ctx（运行时才取，装的先后无关）。
 *
 *   core/state      持久状态、日志
 *   core/outbox     发送出口：按会话 / 整个应用 / 上传限额排队（适配器给 limits）
 *   core/admission  放行（allow / allowChats / observe）、已读、进门、外部发送者的名字
 *   core/delivery   合并送达、等唤醒、重发
 *   core/busy       忙闲（hook）、打断工具
 *   core/control    reply / send_file、「停」、被另一处接管
 *   core/timers     定时
 *   core/endpoint   桥和 hook 连进来的本机端点、工具
 *   extras/*        平台有对应能力才起作用：status-ui（卡片、表情）、history（补拉、未读折叠、read_unread）、recall（撤回）
 *
 * 适配器接口见 wecom.mjs 开头；caps 里没有的能力，对应的扩展整段不工作。
 * 配置字段见 config.example.json。环境变量 FEISHU_CHANNEL_CONFIG 换配置文件，CHANNEL_ADAPTER（旧名 FEISHU_ADAPTER）换适配器（测试用）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { paths, readConfig } from './common.mjs'
import { checkScopes } from './doctor.mjs'
import * as admission from './core/admission.mjs'
import * as busy from './core/busy.mjs'
import * as control from './core/control.mjs'
import * as delivery from './core/delivery.mjs'
import * as endpoint from './core/endpoint.mjs'
import { limitsOf, outbox } from './core/outbox.mjs'
import { ago, loadState, logger } from './core/state.mjs'
import * as timers from './core/timers.mjs'
import * as history from './extras/history.mjs'
import * as recall from './extras/recall.mjs'
import * as statusUi from './extras/status-ui.mjs'
import { accountId, platformOf } from './platform.mjs'
import proc from './proc.mjs'

const cfg = readConfig()
const PLATFORM = platformOf(cfg)
const P = paths(cfg)
mkdirSync(P.dir, { recursive: true })
const log = logger(P.log, PLATFORM.name)
// 适配器：按平台选；测试用 CHANNEL_ADAPTER（或旧名 FEISHU_ADAPTER）换成假实现。
// 路径转成 file URL 再 import：Windows 的绝对路径（C:\…）直接 import 会被当成 URL 协议报错
const adapterFile = process.env.CHANNEL_ADAPTER ?? process.env.FEISHU_ADAPTER
const adapter = adapterFile ? pathToFileURL(adapterFile).href : PLATFORM.adapter
const im = (await import(adapter)).connect(cfg, msg => log(msg))
const { S, save } = loadState(P.state)

/** 平台侧效果（回执、表情、卡片）排成一条串行队列，失败只记日志 */
let fx = Promise.resolve()
const effect = (what, fn, onFail) => {
  fx = fx.then(fn).catch(e => {
    log(`${what} 失败：${e.message}`)
    onFail?.()
  })
}

const ctx = {
  cfg,
  P,
  PLATFORM,
  im,
  S,
  save,
  log,
  effect,
  box: outbox(limitsOf(im.limits, cfg.rateLimit)),
  /** 适配器支持哪些功能；没写的按有（飞书全有）。card 状态卡片和置顶，reaction 回执表情，history 补拉，recall 撤回，scopes 查权限 */
  CAPS: { card: true, reaction: true, history: true, recall: true, scopes: true, ...im.caps },
  TZ: cfg.timezone ?? 'Asia/Shanghai',
  startedAt: Date.now(),
  /** 状态卡片上的提示 */
  warnings: new Set(),
  /** 各模块共用的运行时变量：bridge、pushing、waking、tool、kicked、me … */
  rt: {},
}
for (const m of [statusUi, timers, delivery, busy, control, recall, admission, history, endpoint]) m.install(ctx)
const { rt } = ctx

let stopping = false
function shutdown(why) {
  if (stopping) return
  stopping = true
  log(`退出：${why}`)
  setTimeout(() => process.exit(0), 300)
}

/** 核心权限缺失就退出；其余只提示。查询本身失败不挡启动 */
async function selfCheck() {
  if (!ctx.CAPS.scopes) return
  let granted
  try {
    granted = await im.grantedScopes()
  } catch (e) {
    return log(`权限查询失败，跳过自检：${e.message}`)
  }
  const r = checkScopes(granted)
  for (const n of r.missing) {
    log(`缺权限 ${n.anyOf.join(' 或 ')}，影响：${n.effect}`)
    if (!n.core) ctx.warnings.add(`缺权限：${n.feature}`)
  }
  if (r.coreMissing.length) {
    log(`核心权限缺失（${r.coreMissing.map(n => n.feature).join('、')}），退出`)
    process.exit(78)
  }
  ctx.refreshCard()
}

function listen() {
  rt.stopListen = im.listen({
    onConnected: () => {
      log('长连接已连上')
      ctx.sweep() // 补上断线和启动空档
    },
    onMessage: ev => {
      const { message, eventMs } = ev
      log(`事件到达 ${message?.message_id}：创建→到达 ${ago(message?.create_ms)}ms，事件时间→到达 ${ago(eventMs)}ms，发送者 ${message?.sender?.id}`)
      ctx.onEvent(ev)
    },
    onRecall: (id, { recallMs, eventMs } = {}) => {
      log(`收到撤回事件 ${id}：撤回→到达 ${ago(recallMs)}ms，事件时间→到达 ${ago(eventMs)}ms`)
      ctx.onRecallEvent(id)
    },
    onKicked: reason => ctx.onKicked(reason),
    // 重试也没用的错误（凭据错了）：退出码 78，外层循环等 5 分钟再拉
    onFatal: why => {
      log(`长连接无法建立，退出：${why}`)
      process.exit(78)
    },
  })
}

process.on('unhandledRejection', e => log(`unhandledRejection: ${e}`))
process.on('uncaughtException', e => log(`uncaughtException: ${e}`))
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig))

ctx.makeServer().listen(P.sock, async () => {
  log(`常驻进程启动 pid=${process.pid}，外层循环 ${process.ppid}`)
  // 给 bin/restart.mjs 认人：pid 加启动时刻，防 pid 被复用后杀错
  writeFileSync(P.pidFile, JSON.stringify({ pid: process.pid, start: proc.start(process.pid) }))
  await selfCheck()
  rt.me = accountId(cfg)
  await ctx.sweep()
  if (!ctx.kickedAtStart()) listen()
  ctx.startSweep()
  setInterval(ctx.watchdog, 5000).unref()
  ctx.startTimers()
  ctx.startRecallPoll()
})
