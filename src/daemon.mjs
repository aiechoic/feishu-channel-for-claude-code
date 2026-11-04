#!/usr/bin/env node
/**
 * 飞书 channel 常驻进程：持有事件长连接、已读记录、消息队列、定时和忙闲状态，由 supervise.sh 负责重启。
 *
 * 收：长连接事件带的内容直接入队；启动 / 连上时和定时全量补漏只补漏。以已读记录为准，不漏不重。
 * 放行：只按发送者 id（allow），不按群；其余丢弃并记日志。自己机器人发的跳过。
 *   事件里的发送者对不上 allow 时（机器人只有 open_id），按 get 单条拿到的发送者再判一次。
 * 送：闲时把队列里同一会话的消息合并成一条，经桥（bridge.mjs）送出，桥确认后出队。
 *   忙时白名单发送者的消息也立刻送，Claude Code 在下一次工具调用前后带进这一轮（标成外部内容）；说明、定时和停止标记在时等闲。
 *   会话没就绪时 Claude Code 会静默丢掉通知，所以送出后等到 hook 才算唤醒，等不到退回队列重发。
 * 忙闲：hook.mjs 上报。忙且心跳超时、且没有活着的工具进程时按闲处理。
 * 停：白名单发送者整条消息就是「停」时，清空队列、写停止标记、杀当前工具进程。
 * 撤回：im.message.recalled_v1 事件，低频轮询兜底。排队中的撤下；正在处理的打断这一轮；已处理完的只作废。都不暂停定时。
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
import { checkScopes } from './doctor.mjs'
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
const RECALL_HINT_MS = (cfg.recallHintSec ?? 30) * 1000
const startedAt = Date.now()
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
/** 距某时刻的毫秒数；缺时间戳时返回 ? */
const ago = ms => (ms > 0 ? Date.now() - ms : '?')
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
  warnings.forEach(w => lines.push(`**提示**：${w}`))
  if (S.schedulesPaused) lines.push('**定时**：已暂停')
  else if (upcoming) lines.push(`**下一个定时**：${wall(upcoming.nextAt, TZ)}`)
  return {
    config: { update_multi: true },
    header: { template: offline ? 'grey' : S.busy ? 'orange' : 'green', title: { tag: 'plain_text', content: `${cfg.name ?? 'Claude Code'} ${state}` } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
  }
}

const warnings = new Set()
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
      // 停止标记在、会话还忙：是「停」或撤回打断之前忙时送出的补充这时才进会话，不算新指令，标记留着让这一轮结束
      if (S.busy && existsSync(P.stopFlag)) {
        setBusy(h.event)
        break
      }
      if (!systemWake) S.schedulesPaused = false
      rmSync(P.stopFlag, { force: true })
      setBusy(h.event)
      deliver() // 停止标记清掉了，等着的消息可以忙时送
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

/** 闲时：队首会话的全部排队（含说明、定时）合并送出，等 hook 确认唤醒。
 * 忙时：只送白名单发送者的消息（队列里的消息都已过白名单），说明和定时等闲；停止标记在时（「停」或撤回打断中）也等闲 */
function deliver() {
  if (!bridge || pushing || waking || !S.queue.length) return
  const busy = S.busy
  if (busy && existsSync(P.stopFlag)) return
  const pool = busy ? S.queue.filter(m => !m.notice) : S.queue
  if (!pool.length) return
  const chat = pool[0].chat
  const batch = pool.filter(m => m.chat === chat)
  const first = batch[0]
  const ids = batch.filter(m => !m.notice).map(m => m.message_id)
  const content = batch.length === 1
    ? clip(first.content)
    : batch.map(m => `[${[m.label ?? m.message_id ?? '系统说明', m.sender_name, m.create_time].filter(Boolean).join(' ')}]\n${clip(m.content)}`).join('\n\n')
  pushing = { batch, busy, pushId: `${Date.now()}` }
  if (!busy) {
    rmSync(P.stopFlag, { force: true })
    setBusy('送出消息')
  }
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
      ...(wakeTries && !busy ? { retry: String(wakeTries) } : {}),
    },
  })}\n`)
}

function onAck(pushId) {
  if (pushing?.pushId !== pushId) return
  const { batch, busy } = pushing
  pushing = null
  const sent = new Set(batch)
  S.queue = S.queue.filter(m => !sent.has(m))
  for (const m of batch) {
    if (m.notice) continue
    S.active.push(m.message_id)
    S.delivered[m.message_id] = { chat: m.chat, at: Date.now() }
    react(m.message_id, 'active')
  }
  log(`${busy ? '忙时送出' : '已送出'} ${batch.length} 条：${batch.map(m => (m.notice ? '说明' : `${m.message_id}（创建→送出 ${ago(m.createMs)}ms）`)).join(' ')}`)
  if (busy) {
    // 会话正在跑，Claude Code 在下一次工具调用前后把它带进这一轮，不用等唤醒；它是新指令，同样恢复「停」暂停的定时
    S.schedulesPaused = false
    save()
    refreshCard()
    deliver()
    return
  }
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
  if (!item.notice) log(`入队 ${item.message_id}：创建→入队 ${ago(item.createMs)}ms，忙 ${S.busy}，桥 ${Boolean(bridge)}`)
  deliver()
  if (!item.notice && !pushing?.batch.includes(item)) react(item.message_id, 'queued')
  refreshCard()
}

// ---------- 停和撤回 ----------

const send = (chat, text) => feishu.sendText(chat, text)

/** 写停止标记拦下工具调用，杀当前工具进程；返回杀了没有 */
function interrupt(why) {
  if (!S.busy) return false
  writeFileSync(P.stopFlag, why)
  const pid = toolProcess()
  if (pid) killTree(pid)
  return Boolean(pid)
}

function doStop(chat, why, trigger) {
  const dropped = [...S.queue]
  const lost = dropped.filter(m => m.scheduleId).map(m => m.scheduleId)
  S.queue = []
  dropped.filter(m => !m.notice).forEach(m => react(m.message_id, 'stopped'))
  S.active.forEach(id => react(id, 'stopped'))
  S.active = []
  react(trigger, 'stopped')
  S.schedulesPaused = true
  const killed = interrupt(why)
  log(`停（${why}）：丢 ${dropped.length} 条，杀工具 ${killed}`)
  save()
  refreshCard()
  effect('停的回执', () => send(chat, `已停，丢了 ${dropped.length} 条${lost.length ? `（含定时 ${lost.join(' ')}）` : ''}。${killed ? '当前工具进程已杀。' : ''}定时已暂停，等新指令。`))
}

const RECALL_HINT = '撤回事件可能没订阅'
const eventRecalled = new Set()
let hinted = false

/** 轮询先发现时等一会，事件还是没来才提示；重启空档里的撤回本来就收不到事件，不算 */
function suspectNoRecallEvent(id) {
  if (hinted || Date.now() - startedAt < RECALL_POLL_MS * 2) return
  setTimeout(() => {
    if (hinted || eventRecalled.has(id)) return
    hinted = true
    warnings.add(RECALL_HINT)
    log(`${RECALL_HINT}：${id} 只有轮询发现，没有收到事件`)
    refreshCard()
  }, RECALL_HINT_MS).unref()
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
      suspectNoRecallEvent(id)
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
    refreshCard()
    effect('撤回回执', () => send(queued.chat, `消息 ${id} 已从队列撤下`))
    return
  }
  const d = S.delivered[id]
  if (!d) return
  const running = S.busy && S.active.includes(id)
  delete S.delivered[id]
  delete S.reactions[id]
  S.active = S.active.filter(a => a !== id)
  if (!running) {
    log(`处理完后撤回 ${id}`)
    effect('撤回回执', () => send(d.chat, `消息 ${id} 已作废`))
    enqueue({ notice: true, chat: d.chat, content: `消息 ${id} 已撤回、作废，那一轮已经结束，不要再按它继续做` })
    return
  }
  const peers = [...S.active]
  peers.forEach(a => react(a, 'stopped'))
  S.active = []
  const killed = interrupt(`消息 ${id} 撤回`)
  log(`处理中撤回 ${id}：打断这一轮，杀工具 ${killed}`)
  save()
  effect('撤回回执', () => send(d.chat, `消息 ${id} 已撤回，正在处理它的这一轮已打断。${killed ? '当前工具进程已杀。' : ''}`))
  enqueue({ notice: true, chat: d.chat, content: `消息 ${id} 已撤回、作废，已开始的部分停下并报告做了什么${peers.length ? `。同一轮的 ${peers.join(' ')} 没有撤回，仍要处理` : ''}` })
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
    sender_name: cfg.names?.[s.id] || s.name || s.id || '',
    sender_type: s.sender_type ?? '',
    msg_type: m.msg_type ?? '',
    create_time: m.create_time ?? '',
    createMs: m.create_ms,
  })
}

/** 一条消息进门：放行判断和已读记录只在这里；事件和补漏都走这里，已读过的不再处理 */
function admit(m, chat, isGroup, old) {
  if (seen.has(m.message_id)) return
  const sender = m.sender?.id ?? ''
  if (m.deleted || eventRecalled.has(m.message_id)) log(`跳过 ${m.message_id}：已撤回，创建→发现 ${ago(m.create_ms)}ms`)
  const skip = old || m.deleted || eventRecalled.has(m.message_id) || sender === me || m.msg_type === 'system'
  if (!skip) {
    if (ALLOW.has(sender)) accept(m, chat, isGroup)
    else log(`丢弃 ${m.message_id}：发送者 ${sender} 不在白名单（会话 ${chat}）`)
  }
  markSeen(m.message_id) // 入队落盘之后才记，崩在中间只会重收不会漏
}

/** 事件到了但没能入队的消息：message_id → { chat, tries }，补拉直到拉到 */
const missing = new Map()
const MISSING_TRIES = 5

async function catchUpChat(chat, isGroup, loud) {
  const fresh = isGroup && !known.has(chat) && !firstRun // 新进的群只要最近 24 小时
  const begin = Date.now()
  if (loud) log(`拉取开始 ${chat}`)
  const rows = await unread(chat)
  if (loud || rows.length) log(`拉取结束 ${chat}：${Date.now() - begin}ms，新消息 ${rows.length} 条 ${rows.map(m => m.message_id).join(' ')}`)
  for (const m of rows) admit(m, chat, isGroup, firstRun || (fresh && (m.create_time ?? '') < dayAgo()))
  let again = 0
  for (const [id, w] of missing) {
    if (w.chat !== chat) continue
    if (seen.has(id) || ++w.tries >= MISSING_TRIES) {
      missing.delete(id)
      if (!seen.has(id)) log(`放弃补拉 ${id}：拉了 ${w.tries} 次列表里都没有，等全量补漏`)
    } else {
      log(`列表里还没有 ${id}，单独重拉这个会话`)
      again = Math.max(again, w.tries)
    }
  }
  if (again) retryChat(chat, again)
}

/** 只给这一个会话排重试，不中断全量补漏里的其他会话 */
const chatRetry = new Set()
function retryChat(chat, tries) {
  if (chatRetry.has(chat)) return
  chatRetry.add(chat)
  setTimeout(() => {
    chatRetry.delete(chat)
    schedule(chat)
  }, Math.min(RETRY_MIN_MS * 2 ** (tries - 1), RETRY_MAX_MS)).unref()
}

/** 事件里的 open_id → get 确认过的发送者 id；认过一次的发送者以后不再 get，白名单外的也直接丢 */
const SENDER_CACHE_MAX = 1000
function senderOf(openId) {
  if (!openId) return ''
  return ALLOW.has(openId) ? openId : S.senderIds?.[openId] ?? ''
}
function rememberSender(openId, id) {
  if (!openId || !id || S.senderIds?.[openId] === id) return
  S.senderIds ??= {}
  S.senderIds[openId] = id
  const keys = Object.keys(S.senderIds)
  if (keys.length > SENDER_CACHE_MAX) delete S.senderIds[keys[0]]
  save()
}

/** 事件直入：发送者已知（在白名单或 get 认过）就用事件内容判；没见过或缺字段，按 get 到的发送者判；失败立即补拉这个会话 */
async function onEvent({ chat, chatType, message: m }) {
  if (!m?.message_id) return schedule(chat)
  const id = m.message_id
  if (seen.has(id)) return
  const isGroup = chatType !== 'p2p'
  try {
    const known = senderOf(m.sender?.id)
    if (known) admit({ ...m, sender: { ...m.sender, id: known } }, chat, isGroup)
    else {
      const begin = Date.now()
      const got = await feishu.getMessage(id)
      if (!got) throw new Error('查不到这条消息')
      log(`get 确认 ${id}：${Date.now() - begin}ms，发送者 ${got.sender?.id}`)
      rememberSender(m.sender?.id, got.sender?.id)
      if (got.content !== m.content) log(`事件内容和 get 不一致 ${id}：类型 ${got.msg_type}，长度 ${m.content.length} / ${got.content.length}`)
      admit(got, chat, isGroup)
    }
  } catch (e) {
    log(`事件入队失败 ${id}，立即补拉：${e.message}`)
    if (!seen.has(id)) missing.set(id, { chat, tries: 0 })
  }
  schedule(chat) // 入队不等它；顺带补上这个会话里没来事件的消息
}

async function catchUp(only) {
  const gs = only ? [] : await feishu.listChats()
  const chats = only ? [only] : [...gs, ...dmChats]
  const begin = Date.now()
  for (const chat of chats) await catchUpChat(chat, !dmChats.has(chat), Boolean(only))
  if (!only) log(`全量补漏结束：${chats.length} 个会话，${Date.now() - begin}ms`)
  if (gs.length) {
    gs.forEach(g => known.add(g))
    writeFileSync(P.known, [...known].sort().join('\n'))
  }
}

/** 补漏串行：事件和定时补漏都排进这条队，同一会话排队中的请求合并 */
let tail = Promise.resolve()
let retryWait = RETRY_MIN_MS
const pending = new Set()
const QUEUE_LOG_MS = 100
function schedule(only) {
  const key = only ?? '*'
  if (pending.has(key) || pending.has('*')) return tail
  pending.add(key)
  const asked = Date.now()
  tail = tail.then(async () => {
    pending.delete(key)
    if (Date.now() - asked >= QUEUE_LOG_MS) log(`补漏 ${key} 排队 ${Date.now() - asked}ms`)
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

/** 核心权限缺失就退出；其余只提示。查询本身失败不挡启动 */
async function selfCheck() {
  let granted
  try {
    granted = await feishu.grantedScopes()
  } catch (e) {
    return log(`权限查询失败，跳过自检：${e.message}`)
  }
  const r = checkScopes(granted)
  for (const n of r.missing) {
    log(`缺权限 ${n.anyOf.join(' 或 ')}，影响：${n.effect}`)
    if (!n.core) warnings.add(`缺权限：${n.feature}`)
  }
  if (r.coreMissing.length) {
    log(`核心权限缺失（${r.coreMissing.map(n => n.feature).join('、')}），退出`)
    process.exit(78)
  }
  refreshCard()
}

process.on('unhandledRejection', e => log(`unhandledRejection: ${e}`))
process.on('uncaughtException', e => log(`uncaughtException: ${e}`))
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(sig))

server.listen(P.sock, async () => {
  log(`常驻进程启动 pid=${process.pid}`)
  await selfCheck()
  me = cfg.appId
  await schedule()
  if (firstRun) log('首次运行：现有消息已记为已读')
  feishu.listen({
    onConnected: () => {
      log('长连接已连上')
      schedule() // 补上断线和启动空档
    },
    onMessage: ev => {
      const { chat, chatType, message, eventMs } = ev
      log(`事件到达 ${message?.message_id}：创建→到达 ${ago(message?.create_ms)}ms，事件时间→到达 ${ago(eventMs)}ms，发送者 ${message?.sender?.id}`)
      if (chatType === 'p2p' && !dmChats.has(chat)) {
        dmChats.add(chat)
        appendFileSync(P.dms, `${chat}\n`)
      }
      onEvent(ev)
    },
    onRecall: (id, { recallMs, eventMs } = {}) => {
      log(`收到撤回事件 ${id}：撤回→到达 ${ago(recallMs)}ms，事件时间→到达 ${ago(eventMs)}ms`)
      eventRecalled.add(id)
      onRecall(id)
    },
  })
  if (SWEEP_MS > 0) setInterval(() => schedule(), SWEEP_MS).unref()
  setInterval(watchdog, 5000).unref()
  setInterval(tick, TICK_MS).unref()
  const poll = () => pollRecalls().catch(e => log(`撤回轮询失败：${e.message}`)).finally(() => setTimeout(poll, RECALL_POLL_MS).unref())
  if (RECALL_POLL_MS > 0) setTimeout(poll, RECALL_POLL_MS).unref()
})
