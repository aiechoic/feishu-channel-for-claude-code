#!/usr/bin/env node
/**
 * 飞书 channel 常驻进程：持有事件长连接、已读记录、消息队列、定时和忙闲状态，由 supervise.sh 负责重启。
 *
 * 收：飞书长连接事件 + 启动 / 连上时全量补漏 + 定时全量补漏，以已读记录为准，不漏不重。
 * 放行：只按发送者 id（allow），不按群；其余丢弃并记日志。自己机器人发的跳过。
 * 送：闲时把队列里同一会话的消息合并成一条，经桥（bridge.mjs）送出，桥确认后出队。
 *   会话没就绪时 Claude Code 会静默丢掉通知，所以送出后等到 hook 才算唤醒，等不到退回队列重发。
 * 忙闲：hook.mjs 上报。忙且心跳超时、且没有活着的工具进程时按闲处理。
 * 停：白名单发送者整条消息就是「停」时，清空队列、写停止标记、杀当前工具进程。
 * 撤回：im.message.recalled_v1 事件，低频轮询兜底。
 * 定时：到点进同一条队列；会话不在线时等上线补发，过了宽限期只回报跳过。
 *
 * 配置字段见 config.example.json。环境变量 FEISHU_CHANNEL_CONFIG 换配置文件，FEISHU_ADAPTER 换飞书适配器（测试用）。
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { paths, readConfig } from './common.mjs'
import { next, parseAdd, procStart, wall } from './schedule.mjs'

const cfg = readConfig()
const P = paths(cfg)
mkdirSync(P.dir, { recursive: true })
const feishu = (await import(process.env.FEISHU_ADAPTER ?? './feishu.mjs')).connect(cfg, msg => log(msg))
const ALLOW = new Set(cfg.allow)
const SWEEP_MS = (cfg.sweepSec ?? 600) * 1000
const BUSY_TIMEOUT_MS = (cfg.busyTimeoutSec ?? 180) * 1000
const RECALL_POLL_MS = (cfg.recallPollSec ?? 60) * 1000
const RECALL_WINDOW_MS = (cfg.recallWindowSec ?? 3600) * 1000
const CARD_DEBOUNCE_MS = (cfg.cardDebounceSec ?? 5) * 1000
const TZ = cfg.timezone ?? 'Asia/Shanghai'
const GRACE_MIN = { once: cfg.onceGraceMin ?? 10_080, daily: cfg.repeatGraceMin ?? 720, weekly: cfg.repeatGraceMin ?? 720 }
const TICK_MS = (cfg.scheduleTickSec ?? 15) * 1000
const LATE_MS = 60_000
const CARD_RETRY_MS = 30_000
const CLIP = 6000
const MAX_PAGES = 5
const RETRY_MIN_MS = (cfg.retrySec ?? 5) * 1000
const RETRY_MAX_MS = 60_000
const WAKE_TIMEOUT_MS = (cfg.wakeTimeoutSec ?? 20) * 1000
const WAKE_TIMEOUT_MAX_MS = 300_000
const EMOJI = { queued: 'GLANCE', active: 'OneSecond', done: 'CheckMark', stopped: 'CrossMark' }

function log(msg) {
  const line = `[feishu] ${msg}`
  console.error(line)
  try {
    appendFileSync(P.log, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 日志写不了不影响收发
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const words = file => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).filter(Boolean) : [])
const hhmm = ms => new Date(ms).toTimeString().slice(0, 5)

// ---------- 持久状态 ----------

const S = {
  queue: [], // 待送消息；notice 为常驻进程自己生成的说明
  active: [], // 送达后正在处理的 message_id
  delivered: {}, // message_id → { chat, at }，撤回轮询用
  reactions: {}, // message_id → { kind, id }
  card: null, // 状态卡片 message_id
  schedules: [], // { id, kind, text, graceMin?, nextAt, time?, weekday?, pid?, start? }
  nextScheduleId: 1,
  schedulesPaused: false,
  busy: false,
  since: Date.now(),
  claudePid: 0,
  inflight: {}, // tool_use_id → { tool, at }，前台工具
  ...(existsSync(P.state) ? JSON.parse(readFileSync(P.state, 'utf8')) : {}),
}

function save() {
  const tmp = `${P.state}.tmp`
  writeFileSync(tmp, JSON.stringify(S))
  renameSync(tmp, P.state)
}

// ---------- 飞书侧效果：表情和卡片，串行，失败只记日志 ----------

let fx = Promise.resolve()
const effect = (what, fn, onFail) => {
  fx = fx.then(fn).catch(e => {
    log(`${what} 失败：${e.message}`)
    onFail?.()
  })
}

function react(id, kind) {
  if (!id || S.reactions[id]?.kind === kind) return
  S.reactions[id] = { kind, id: S.reactions[id]?.id ?? '' }
  effect(`表情 ${id}`, async () => {
    const old = S.reactions[id]?.id // 串行执行到这里时前一个表情的 id 才可用
    if (old) {
      await feishu.removeReaction(id, old)
    }
    const reactionId = await feishu.addReaction(id, EMOJI[kind])
    if (S.reactions[id]) S.reactions[id].id = reactionId
    save()
  })
}

function cardBody() {
  const offline = !bridge
  const state = offline ? '离线' : S.busy ? '忙' : '闲'
  const lines = [`**状态**：${state}（${hhmm(S.since)} 起）`, `**排队**：${S.queue.length} 条`]
  if (S.busy && tool) lines.splice(1, 0, `**当前工具**：${tool}`)
  const upcoming = nextSchedule()
  if (S.schedulesPaused) lines.push('**定时**：已暂停')
  else if (upcoming) lines.push(`**下一个定时**：${wall(upcoming.nextAt, TZ)}`)
  return {
    config: { update_multi: true },
    header: { template: offline ? 'grey' : S.busy ? 'orange' : 'green', title: { tag: 'plain_text', content: `${cfg.name ?? 'Claude Code'} ${state}` } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
  }
}

let cardShown = ''
let cardTimer = null
function refreshCard() {
  if (!cfg.statusChat || cardTimer) return
  cardTimer = setTimeout(() => {
    cardTimer = null
    const content = JSON.stringify(cardBody())
    if (content === cardShown) return
    cardShown = content
    effect('状态卡片', async () => {
      if (S.card) {
        await feishu.patchCard(S.card, content)
        return
      }
      S.card = await feishu.sendCard(cfg.statusChat, content)
      save()
      await feishu.pin(S.card)
    }, () => { // 下次检查时重发，不让卡片停在旧状态
      cardShown = ''
      setTimeout(refreshCard, CARD_RETRY_MS).unref()
    })
  }, CARD_DEBOUNCE_MS)
}

// ---------- 忙闲 ----------

let bridge = null // { sock, claudePid, bridgePid }
let tool = ''
let beat = Date.now()

function setBusy(why) {
  beat = Date.now()
  if (S.busy) return
  S.busy = true
  S.since = Date.now()
  log(`标忙：${why}`)
  save()
  refreshCard()
}

function setIdle(why, finished) {
  rmSync(P.stopFlag, { force: true })
  S.inflight = {}
  tool = ''
  if (S.busy) {
    S.busy = false
    S.since = Date.now()
    log(`标闲：${why}`)
  }
  if (finished) S.active.forEach(id => react(id, 'done'))
  S.active = []
  save()
  refreshCard()
  deliver()
}

function onHook(h) {
  log(`hook ${h.event}${h.tool ? ` ${h.tool}` : ''}${h.blocked ? '（已拦）' : ''}`)
  const systemWake = waking?.batch.every(m => m.notice) // 系统说明和定时唤醒的一轮不算新指令
  woke() // 只在闲时送出，送出后的任何 hook 都说明会话收到了
  switch (h.event) {
    case 'UserPromptSubmit':
      if (!systemWake) S.schedulesPaused = false
      rmSync(P.stopFlag, { force: true })
      setBusy(h.event)
      break
    case 'PreToolUse':
      setBusy(h.event)
      if (h.blocked) {
        setTimeout(() => S.busy && existsSync(P.stopFlag) && setIdle('停止标记拦下', false), 3000)
        break
      }
      tool = h.tool
      if (!h.background) S.inflight[h.toolUseId] = { tool: h.tool, at: Date.now() }
      save()
      refreshCard()
      break
    case 'PostToolUse':
    case 'PostToolUseFailure':
      beat = Date.now()
      delete S.inflight[h.toolUseId]
      tool = Object.values(S.inflight).at(-1)?.tool ?? ''
      save()
      refreshCard()
      break
    case 'Stop':
      setIdle(h.event, true)
      break
  }
}

/** 当前前台 Bash 工具的进程：Claude Code 的子 shell 里，开始时间不早于那次 PreToolUse 的最新一个 */
function toolProcess() {
  const started = Object.values(S.inflight).filter(t => t.tool === 'Bash').map(t => t.at)
  if (!bridge || !started.length) return null
  const after = Math.min(...started) - 2000
  const boot = Number(/^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))[1]) * 1000
  const shells = table().filter(p => p.ppid === bridge.claudePid && p.pid !== bridge.bridgePid
    && /^(ba|z|da)?sh$/.test(p.comm) && boot + p.start * 10 >= after
    && !readCmd(p.pid).includes('hook.mjs'))
  return shells.sort((a, b) => b.start - a.start)[0]?.pid ?? null
}

function readCmd(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return ''
  }
}

function table() {
  const rows = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const f = stat.slice(close + 2).split(' ')
      rows.push({ pid: Number(name), comm: stat.slice(stat.indexOf('(') + 1, close), ppid: Number(f[1]), start: Number(f[19]) })
    } catch {
      // 进程刚退出
    }
  }
  return rows
}

function killTree(root) {
  const rows = table()
  const tree = [root]
  for (let i = 0; i < tree.length; i++) tree.push(...rows.filter(p => p.ppid === tree[i]).map(p => p.pid))
  const send = sig => tree.forEach(pid => {
    try {
      process.kill(pid, sig)
    } catch {
      // 已退出
    }
  })
  send('SIGTERM')
  setTimeout(() => send('SIGKILL'), 2000).unref()
  log(`已杀工具进程树 ${tree.join(' ')}`)
}

function watchdog() {
  if (!S.busy || Date.now() - beat < BUSY_TIMEOUT_MS) return
  if (toolProcess()) {
    beat = Date.now()
    return
  }
  setIdle('心跳超时', false)
}

// ---------- 送达 ----------

let pushing = null
let waking = null // { batch, timer }：已送出、等会话唤醒
let wakeTries = 0

function clip(text) {
  return text.length <= CLIP ? text : `${text.slice(0, CLIP)} …[已截断，全文按 message_id 用 lark-cli 拉]`
}

function deliver() {
  if (S.busy || !bridge || pushing || waking || !S.queue.length) return
  const chat = S.queue[0].chat
  const batch = S.queue.filter(m => m.chat === chat)
  const first = batch[0]
  const ids = batch.filter(m => !m.notice).map(m => m.message_id)
  const content = batch.length === 1
    ? clip(first.content)
    : batch.map(m => `[${[m.label ?? m.message_id ?? '系统说明', m.sender_name, m.create_time].filter(Boolean).join(' ')}]\n${clip(m.content)}`).join('\n\n')
  pushing = { batch, pushId: `${Date.now()}` }
  rmSync(P.stopFlag, { force: true })
  setBusy('送出消息')
  bridge.sock.write(`${JSON.stringify({
    t: 'push',
    pushId: pushing.pushId,
    content,
    meta: {
      chat_id: chat,
      chat_type: first.chat_type ?? 'group',
      message_id: ids.join(','),
      sender_id: first.sender_id ?? 'system',
      sender_name: first.sender_name ?? '飞书 channel',
      sender_type: first.sender_type ?? 'system',
      msg_type: first.msg_type ?? 'text',
      create_time: first.create_time ?? '',
      merged: String(batch.length),
      ...(wakeTries ? { retry: String(wakeTries) } : {}),
    },
  })}\n`)
}

function onAck(pushId) {
  if (pushing?.pushId !== pushId) return
  const { batch } = pushing
  pushing = null
  const sent = new Set(batch)
  S.queue = S.queue.filter(m => !sent.has(m))
  for (const m of batch) {
    if (m.notice) continue
    S.active.push(m.message_id)
    S.delivered[m.message_id] = { chat: m.chat, at: Date.now() }
    react(m.message_id, 'active')
  }
  log(`已送出 ${batch.length} 条：${batch.map(m => m.message_id ?? '说明').join(' ')}`)
  save()
  refreshCard()
  const wait = Math.min(WAKE_TIMEOUT_MS * 2 ** wakeTries, WAKE_TIMEOUT_MAX_MS)
  waking = { batch, timer: setTimeout(notWoken, wait) }
  waking.timer.unref()
}

function woke() {
  if (!waking) return
  clearTimeout(waking.timer)
  log(`已唤醒，送达确认 ${waking.batch.length} 条`)
  waking = null
  wakeTries = 0
}

/** 通知被静默丢弃：退回队首重发。若其实收到了只是没触发 hook，会多送一次，meta.retry 标明，按 message_id 去重 */
function notWoken() {
  const { batch } = waking
  waking = null
  wakeTries++
  const ids = new Set(batch.map(m => m.message_id))
  S.active = S.active.filter(id => !ids.has(id))
  for (const id of ids) delete S.delivered[id]
  S.queue.unshift(...batch)
  batch.filter(m => !m.notice).forEach(m => react(m.message_id, 'queued'))
  log(`${batch.length} 条送出后没有唤醒会话，退回队列，第 ${wakeTries} 次重发`)
  setIdle('未唤醒', false)
}

function enqueue(item) {
  S.queue.push(item)
  save()
  if (!item.notice && (S.busy || !bridge || pushing)) react(item.message_id, 'queued')
  refreshCard()
  deliver()
}

// ---------- 停和撤回 ----------

const send = (chat, text) => feishu.sendText(chat, text)

function doStop(chat, why, trigger) {
  const dropped = [...S.queue]
  const lost = dropped.filter(m => m.scheduleId).map(m => m.scheduleId)
  S.queue = []
  dropped.filter(m => !m.notice).forEach(m => react(m.message_id, 'stopped'))
  S.active.forEach(id => react(id, 'stopped'))
  S.active = []
  react(trigger, 'stopped')
  S.schedulesPaused = true
  let killed = false
  if (S.busy) {
    writeFileSync(P.stopFlag, why)
    const pid = toolProcess()
    if (pid) {
      killTree(pid)
      killed = true
    }
  }
  log(`停（${why}）：丢 ${dropped.length} 条，杀工具 ${killed}`)
  save()
  refreshCard()
  effect('停的回执', () => send(chat, `已停，丢了 ${dropped.length} 条${lost.length ? `（含定时 ${lost.join(' ')}）` : ''}。${killed ? '当前工具进程已杀。' : ''}定时已暂停，等新指令。`))
}

async function pollRecalls() {
  const now = Date.now()
  for (const [id, d] of Object.entries(S.delivered)) {
    if (now - d.at > RECALL_WINDOW_MS) delete S.delivered[id]
  }
  const ids = [...S.queue.filter(m => !m.notice).map(m => m.message_id), ...Object.keys(S.delivered)]
  for (const id of ids) {
    const m = await feishu.getMessage(id)
    if (m?.deleted) {
      log(`轮询发现撤回 ${id}`)
      onRecall(id)
    }
  }
}

function onRecall(id) {
  const queued = S.queue.find(m => m.message_id === id)
  if (queued) {
    S.queue = S.queue.filter(m => m !== queued)
    delete S.reactions[id]
    log(`排队中撤回 ${id}，不送`)
    save()
    return refreshCard()
  }
  const d = S.delivered[id]
  if (!d) return
  delete S.delivered[id]
  delete S.reactions[id]
  S.active = S.active.filter(a => a !== id)
  log(`送达后撤回 ${id}`)
  doStop(d.chat, `消息 ${id} 撤回`)
  enqueue({ notice: true, chat: d.chat, content: `消息 ${id} 已撤回、作废，已开始的部分停下并报告做了什么` })
}

// ---------- 补漏 ----------

const firstRun = !existsSync(P.seen)
if (firstRun) writeFileSync(P.seen, '')
const seen = new Set(words(P.seen))
const dmChats = new Set(words(P.dms))
const known = new Set(words(P.known))
let me = ''

function markSeen(id) {
  seen.add(id)
  appendFileSync(P.seen, `\n${id}`)
}

/** 拉一个会话里没读过的消息，旧的在前；翻到有已读的那页为止 */
async function unread(chat) {
  const rows = []
  let token
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await feishu.listMessages(chat, token)
    const fresh = data.messages.filter(m => !seen.has(m.message_id))
    rows.unshift(...fresh.reverse())
    if (fresh.length < data.messages.length || !data.hasMore || !data.pageToken || firstRun) return rows
    token = data.pageToken
  }
  log(`会话 ${chat} 超过 ${MAX_PAGES * 50} 条未读，更早的消息没有补`)
  return rows
}

function dayAgo() {
  const d = new Date(Date.now() - 86_400_000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function accept(m, chat, isGroup) {
  const s = m.sender ?? {}
  if (m.msg_type === 'text' && (m.content ?? '').trim() === '停') return doStop(chat, '收到「停」', m.message_id)
  enqueue({
    chat,
    chat_type: isGroup ? 'group' : 'p2p',
    message_id: m.message_id,
    content: m.content ?? '',
    sender_id: s.id ?? '',
    sender_name: cfg.names?.[s.id] ?? s.name ?? '',
    sender_type: s.sender_type ?? '',
    msg_type: m.msg_type ?? '',
    create_time: m.create_time ?? '',
  })
}

async function catchUpChat(chat, isGroup) {
  const fresh = isGroup && !known.has(chat) && !firstRun // 新进的群只要最近 24 小时
  for (const m of await unread(chat)) {
    const sender = m.sender?.id ?? ''
    const skip = firstRun || m.deleted || sender === me || m.msg_type === 'system'
      || (fresh && (m.create_time ?? '') < dayAgo())
    if (!skip) {
      if (ALLOW.has(sender)) accept(m, chat, isGroup)
      else log(`丢弃 ${m.message_id}：发送者 ${sender} 不在白名单（会话 ${chat}）`)
    }
    markSeen(m.message_id) // 入队落盘之后才记，崩在中间只会重收不会漏
  }
}

async function catchUp(only) {
  const gs = only ? [] : await feishu.listChats()
  const chats = only ? [only] : [...gs, ...dmChats]
  for (const chat of chats) await catchUpChat(chat, !dmChats.has(chat))
  if (gs.length) {
    gs.forEach(g => known.add(g))
    writeFileSync(P.known, [...known].sort().join('\n'))
  }
}

/** 补漏串行：事件和定时补漏都排进这条队，同一会话排队中的请求合并 */
let tail = Promise.resolve()
let retryWait = RETRY_MIN_MS
const pending = new Set()
function schedule(only) {
  const key = only ?? '*'
  if (pending.has(key) || pending.has('*')) return tail
  pending.add(key)
  tail = tail.then(async () => {
    pending.delete(key)
    await catchUp(only)
    retryWait = RETRY_MIN_MS
  }).catch(e => {
    log(`补漏失败，${retryWait / 1000} 秒后重试：${e.message}`)
    setTimeout(() => schedule(only), retryWait).unref()
    retryWait = Math.min(retryWait * 2, RETRY_MAX_MS)
  })
  return tail
}

// ---------- 定时 ----------

function nextSchedule() {
  return S.schedules.filter(j => j.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0]
}

function lateness(ms) {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`
}

function fire(job, chat, label) {
  enqueue({ notice: true, label: `定时 ${job.id}`, scheduleId: job.id, chat, content: `[定时 ${job.id}]${label} ${job.text}` })
  log(`定时 ${job.id} 触发`)
}

/** 会话不在线或「停」之后不触发，等恢复后再判宽限期 */
function tick() {
  const chat = cfg.statusChat
  if (!bridge || !chat || S.schedulesPaused) return
  const now = Date.now()
  for (const job of [...S.schedules]) {
    if (job.kind === 'process') {
      if (procStart(job.pid) === job.start) continue
      fire(job, chat, `（进程 ${job.pid} 已结束，${wall(now, TZ)} 发现）`)
    } else {
      if (job.nextAt > now) continue
      const late = now - job.nextAt
      if (late <= (job.graceMin ?? GRACE_MIN[job.kind]) * 60_000) {
        fire(job, chat, late > LATE_MS ? `（原定 ${wall(job.nextAt, TZ)}，晚了 ${lateness(late)}）` : `（${wall(job.nextAt, TZ)}）`)
      } else {
        log(`定时 ${job.id} 过了宽限期，跳过`)
        effect('定时跳过回报', () => send(chat, `定时 ${job.id} 原定 ${wall(job.nextAt, TZ)}，过了宽限期没有补发：${job.text}`))
      }
    }
    if (job.kind === 'daily' || job.kind === 'weekly') job.nextAt = next(job, TZ, now)
    else S.schedules = S.schedules.filter(j => j !== job)
    save()
    refreshCard()
  }
}

function onSchedule({ action, args = {} }) {
  if (action === 'add') {
    const job = { id: `s${S.nextScheduleId++}`, ...parseAdd(args, TZ, Date.now()) }
    S.schedules.push(job)
    save()
    refreshCard()
    return `已加定时 ${job.id}，${job.nextAt ? `下一次 ${wall(job.nextAt, TZ)}（${TZ}）` : `等进程 ${job.pid} 结束`}`
  }
  if (action === 'list') {
    const when = j => (j.kind === 'process' ? `等进程 ${j.pid}` : `下一次 ${wall(j.nextAt, TZ)}`)
    return [S.schedulesPaused ? '定时已暂停（「停」之后，下一条新指令恢复）' : '', ...S.schedules.map(j => `${j.id} ${j.kind} ${when(j)}：${j.text}`)].filter(Boolean).join('\n') || '没有定时'
  }
  if (action === 'remove') {
    const before = S.schedules.length
    S.schedules = S.schedules.filter(j => j.id !== args.id)
    if (S.schedules.length === before) throw new Error(`没有定时 ${args.id}`)
    save()
    refreshCard()
    return `已删定时 ${args.id}`
  }
  throw new Error(`未知操作：${action}`)
}

// ---------- 桥和 hook 的本地连接 ----------

function onLine(sock, line) {
  const m = JSON.parse(line)
  if (m.t === 'hook') onHook(m)
  else if (m.t === 'ack') onAck(m.pushId)
  else if (m.t === 'hello') {
    bridge = { sock, claudePid: m.claudePid, bridgePid: m.bridgePid }
    log(`桥已连上：claude ${m.claudePid}`)
    if (S.claudePid === m.claudePid) { // 同一会话重连，忙闲沿用
      refreshCard()
      deliver()
    } else {
      S.claudePid = m.claudePid
      setIdle('新会话', false)
    }
  } else if (m.t === 'schedule') {
    let r
    try {
      r = { ok: true, text: onSchedule(m) }
    } catch (e) {
      r = { ok: false, text: e.message }
    }
    sock.write(`${JSON.stringify({ t: 'reply-result', id: m.id, ...r })}\n`)
  } else if (m.t === 'reply') {
    send(m.chat_id, m.text).then(
      id => sock.write(`${JSON.stringify({ t: 'reply-result', id: m.id, ok: true, text: `已发送 ${id}` })}\n`),
      e => sock.write(`${JSON.stringify({ t: 'reply-result', id: m.id, ok: false, text: `发送失败：${e.message}` })}\n`),
    )
  }
}

let stopping = false
rmSync(P.sock, { force: true })
const server = createServer(sock => {
  sock.on('error', () => {})
  createInterface({ input: sock }).on('error', () => {}).on('line', line => {
    try {
      onLine(sock, line)
    } catch (e) {
      log(`本地消息处理失败：${e.message}`)
    }
  })
  sock.on('close', () => {
    if (bridge?.sock !== sock) return
    bridge = null
    pushing = null
    if (waking) notWoken()
    log('桥断开，会话离线')
    S.claudePid = 0
    setIdle('会话离线', false)
  })
})

function shutdown(why) {
  if (stopping) return
  stopping = true
  log(`退出：${why}`)
  setTimeout(() => process.exit(0), 300)
}

process.on('unhandledRejection', e => log(`unhandledRejection: ${e}`))
process.on('uncaughtException', e => log(`uncaughtException: ${e}`))
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig))

server.listen(P.sock, async () => {
  log(`常驻进程启动 pid=${process.pid}`)
  me = cfg.appId
  await schedule()
  if (firstRun) log('首次运行：现有消息已记为已读')
  feishu.listen({
    onConnected: () => {
      log('长连接已连上')
      schedule() // 补上断线和启动空档
    },
    onMessage: ({ chat, chatType }) => {
      if (chatType === 'p2p' && !dmChats.has(chat)) {
        dmChats.add(chat)
        appendFileSync(P.dms, `${chat}\n`)
      }
      schedule(chat)
    },
    onRecall: id => {
      log(`收到撤回事件 ${id}`)
      onRecall(id)
    },
  })
  if (SWEEP_MS > 0) setInterval(() => schedule(), SWEEP_MS).unref()
  setInterval(watchdog, 5000).unref()
  setInterval(tick, TICK_MS).unref()
  const poll = () => pollRecalls().catch(e => log(`撤回轮询失败：${e.message}`)).finally(() => setTimeout(poll, RECALL_POLL_MS).unref())
  if (RECALL_POLL_MS > 0) setTimeout(poll, RECALL_POLL_MS).unref()
})
