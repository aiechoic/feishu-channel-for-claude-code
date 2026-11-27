// 往外发和「停」：reply / send_file 都经 outbox 排队限流；被另一处接管（kicked）后一律拒发。
// 停：白名单发送者整条消息就是「停」时，清空队列、写停止标记、杀当前工具进程，定时暂停到下一条新指令。
import { existsSync, writeFileSync } from 'node:fs'

export function install(ctx) {
  const { cfg, P, S, save, log, im, box, PLATFORM, rt } = ctx
  const KICKED_WARNING = '长连接被另一处接管，本机已停用'
  const KICKED_HINT = `${PLATFORM.label}长连接被另一处的新连接接管了，本机已停止收发（不重连，免得两边来回抢）。要在本机继续用，先确认另一处已经停了，再跑 node bin/restart.mjs`
  rt.kicked = existsSync(P.kicked)

  const send = (chat, text, opts) => {
    if (rt.kicked) return Promise.reject(new Error(KICKED_HINT))
    return box.send(chat, () => (opts ? im.sendText(chat, text, opts) : im.sendText(chat, text)))
  }

  /** 本机文件发到会话：先上传（上传桶限额），再发（会话桶限额） */
  async function sendFile(chat, path) {
    if (rt.kicked) throw new Error(KICKED_HINT)
    if (!im.upload) throw new Error(`${PLATFORM.label}不支持发文件`)
    const media = await box.upload(() => im.upload(path))
    return box.send(chat, () => im.sendMedia(chat, media))
  }

  const writeStopFlag = why => writeFileSync(P.stopFlag, why)

  function doStop(chat, why, trigger) {
    const dropped = [...S.queue]
    const lost = dropped.filter(m => m.scheduleId).map(m => m.scheduleId)
    S.queue = []
    dropped.filter(m => !m.notice).forEach(m => ctx.react(m.message_id, 'stopped'))
    S.active.forEach(id => ctx.react(id, 'stopped'))
    S.active = []
    ctx.react(trigger, 'stopped')
    S.schedulesPaused = true
    const killed = ctx.interrupt(why)
    log(`停（${why}）：丢 ${dropped.length} 条，杀工具 ${killed}`)
    save()
    ctx.refreshCard()
    ctx.effect('停的回执', () => send(chat, `已停，丢了 ${dropped.length} 条${lost.length ? `（含定时 ${lost.join(' ')}）` : ''}。${killed ? '当前工具进程已杀。' : ''}定时已暂停，等新指令。`))
  }

  /** 同一个账号只能有一条有效长连接的平台：被另一处的新连接踢下线。不重连（重连会把对方踢掉，两边来回抢），
   * 留标记、停用发送，告诉会话；常驻进程不退出（退出会被外层循环拉起来再抢） */
  function onKicked(reason) {
    rt.kicked = true
    writeFileSync(P.kicked, JSON.stringify({ at: Date.now(), reason }))
    log(`长连接被另一处接管（${reason}），本机不再重连。确认另一处已经停了，再跑 node bin/restart.mjs 拿回来`)
    ctx.warnings.add(KICKED_WARNING)
    try {
      rt.stopListen?.()
    } catch {}
    kickNotice()
  }

  /** 被踢之后每个会话告诉一次：reply 已停用，怎么拿回来 */
  let kickNoticed = 0
  function kickNotice() {
    if (!rt.kicked || !rt.bridge || kickNoticed === S.claudePid) return
    kickNoticed = S.claudePid
    ctx.enqueue({ notice: true, urgent: true, chat: cfg.statusChat ?? '', content: `[${PLATFORM.label} channel] ${KICKED_HINT}。这期间别人发的消息收不到。` })
  }

  /** 启动时标记还在：这次不连 */
  function kickedAtStart() {
    if (!rt.kicked) return false
    log(`${P.kicked} 在：长连接之前被另一处的新连接接管过，这次不连。确认另一处已经停了，再跑 node bin/restart.mjs 拿回来`)
    ctx.warnings.add(KICKED_WARNING)
    return true
  }

  Object.assign(ctx, { send, sendFile, writeStopFlag, doStop, onKicked, kickNotice, kickedAtStart })
}
