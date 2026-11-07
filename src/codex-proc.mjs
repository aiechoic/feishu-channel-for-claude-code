import { isCommandShell } from './proc.mjs'
import { posix } from 'node:path'

/** 解析 Codex 显示的 shell 转义命令，只解析、不执行。 */
export function shellWords(text) {
  const words = []
  let word = '', quote = '', started = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") { if (c === quote) quote = ''; else word += c }
    else if (quote === '"') {
      if (c === quote) quote = ''
      else if (c === '\\' && /["\\$`\n]/.test(text[i + 1] ?? '')) word += text[++i]
      else word += c
    } else if (c === "'" || c === '"') { quote = c; started = true }
    else if (c === '\\') { if (++i >= text.length) return []; word += text[i]; started = true }
    else if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false } }
    else { word += c; started = true }
  }
  if (quote) return []
  if (started) words.push(word)
  return words
}

/** 按 Windows 的引号与反斜杠规则解析 argv，不经过 shell。 */
export function windowsWords(text) {
  const words = []
  let i = 0
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++
    if (i >= text.length) break
    let word = '', quote = false
    while (i < text.length && (quote || !/\s/.test(text[i]))) {
      let slashes = 0
      while (text[i] === '\\') { slashes++; i++ }
      if (text[i] === '"') {
        word += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) word += '"'
        else quote = !quote
        i++
      } else {
        word += '\\'.repeat(slashes)
        if (i < text.length) word += text[i++]
      }
    }
    if (quote) return []
    words.push(word)
  }
  return words
}

const clean = s => s.replaceAll('\r\n', '\n').trim()
function body(args) {
  const i = args.findIndex(a => /^(?:-command|-c|-lc)$/i.test(a))
  return i >= 0 && args.length === i + 2 ? clean(args[i + 1]) : ''
}
export function commandMatches(display, process, platform = process.platform) {
  if (!isCommandShell(process)) return false
  const expected = body(shellWords(display))
  if (!expected) return false
  const argv = process.cmd.includes('\0') ? process.cmd.split('\0').filter(Boolean)
    : platform === 'win32' ? windowsWords(process.cmd) : shellWords(process.cmd)
  const actual = body(argv)
  // Codex 会在原 PowerShell 脚本前加一段 UTF-8 控制台初始化代码。
  return actual === expected || actual.endsWith('\n' + expected)
}

/** 只支持不含展开、重定向或控制运算符的末尾简单命令，无法确认时不猜测。 */
export function finalCommand(display) {
  const script = body(shellWords(display))
  let quote = '', start = 0, tail = ''
  for (let i = 0; i < script.length; i++) {
    const c = script[i]
    if (c === '\\' && quote !== "'") { i++; continue }
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === "'" || c === '"') quote = c
    else if (c === ';' || c === '\n') { if (script.slice(start, i).trim()) tail = script.slice(start, i).trim(); start = i + 1 }
  }
  if (quote) return []
  if (script.slice(start).trim()) tail = script.slice(start).trim()
  if (/[|&<>(){}$`*?\[\]]/.test(tail)) return []
  const args = shellWords(tail)
  if (args[0] === 'exec') args.shift()
  if (!args.length || !/^[\w./+-]+$/.test(args[0]) || args[0].startsWith('-')) return []
  return args
}

function execMatches(display, process) {
  const expected = finalCommand(display)
  if (!expected.length || !process.cmd.includes('\0')) return false
  const actual = process.cmd.split('\0')
  if (actual.at(-1) === '') actual.pop()
  if (actual.length !== expected.length) return false
  if (expected[0].includes('/') ? actual[0] !== expected[0] : posix.basename(actual[0]) !== expected[0]) return false
  return actual.slice(1).every((a, i) => a === expected[i + 1])
}

/** 共享 daemon 的子进程属于多个会话，必须核对本线程命令且唯一匹配。 */
export class CodexCommands {
  constructor(proc, rootPid, platform = process.platform, now = Date.now, { threadId, report = () => {} } = {}) {
    this.proc = proc
    this.rootPid = rootPid
    this.rootStart = proc.start(rootPid)
    this.platform = platform
    this.now = now
    this.items = new Map()
    this.threadId = threadId
    this.report = report
  }
  observe(method, p) {
    if (method === 'turn/completed') {
      for (const [id, item] of this.items) if (item.turnId === p.turn.id) this.items.delete(id)
      return
    }
    const item = p.item
    if (item?.type !== 'commandExecution' || !item.command) return
    if (method === 'item/started') this.items.set(item.id, { command: item.command, at: this.now(), turnId: p.turnId })
    // 已返回 session_id 但没有退出码的命令仍需在停止时清理。
    if (method === 'item/completed' && item.exitCode != null) this.items.delete(item.id)
  }
  stop(turnId) {
    if (!this.rootStart || this.proc.start(this.rootPid) !== this.rootStart) {
      this.report('根进程不可验证，未杀任何命令进程')
      return []
    }
    const tree = () => this.platform === 'linux' && this.proc.descendants ? this.proc.descendants(this.rootPid) : this.proc.children(this.rootPid)
    const children = tree()
    const killed = []
    for (const [id, item] of this.items) {
      if (item.turnId !== turnId) continue
      const eligible = children.filter(p => p.startMs >= item.at - 2000)
      let matches = eligible.filter(p => commandMatches(item.command, p, this.platform))
      let replaced = false
      if (!matches.length && this.platform === 'linux' && this.threadId) {
        // shell 可 exec 成末尾命令；完整 argv 与 CODEX_THREAD_ID 同时匹配才放行。
        replaced = true
        matches = eligible.filter(p => this.proc.threadId?.(p.pid) === this.threadId && execMatches(item.command, p))
      }
      if (matches.length !== 1) {
        this.report(`命令 ${id} ${matches.length ? '归属匹配有歧义' : '无可验证匹配'}，仅中断轮次`)
        continue
      }
      const p = matches[0]
      const start = this.proc.start(p.pid)
      if (start === null) continue
      // 杀树前重新确认父子关系、命令、线程与启动身份，防 PID 复用。
      const current = tree().find(c => c.pid === p.pid)
      const sameCommand = current && (replaced
        ? this.proc.threadId?.(p.pid) === this.threadId && execMatches(item.command, current)
        : commandMatches(item.command, current, this.platform))
      if (!current || current.startMs !== p.startMs || this.proc.start(p.pid) !== start || !sameCommand) {
        this.report(`命令 ${id} 启动身份或归属复核失败，未杀进程`)
        continue
      }
      killed.push(...this.proc.killTree(p.pid))
      this.items.delete(id)
    }
    return killed
  }
}
