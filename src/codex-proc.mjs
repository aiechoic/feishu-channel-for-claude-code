import { isCommandShell } from './proc.mjs'

/** Parse Codex's shell-escaped command display without evaluating it. */
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

/** Windows command-line argv decoding (quote/backslash rules); no shell execution. */
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
  // Codex adds the UTF-8 console preamble before the original PowerShell script.
  return actual === expected || actual.endsWith('\n' + expected)
}

/** Shared daemon children are not session-owned: require this thread's exact command and a unique match. */
export class CodexCommands {
  constructor(proc, rootPid, platform = process.platform, now = Date.now) {
    this.proc = proc
    this.rootPid = rootPid
    this.rootStart = proc.start(rootPid)
    this.platform = platform
    this.now = now
    this.items = new Map()
  }
  observe(method, p) {
    const item = p.item
    if (item?.type !== 'commandExecution' || !item.command) return
    if (method === 'item/started') this.items.set(item.id, { command: item.command, at: this.now(), turnId: p.turnId })
    // A yielded exec session has no exitCode and remains a target even after the tool returns.
    if (method === 'item/completed' && item.exitCode != null) this.items.delete(item.id)
  }
  stop(turnId) {
    if (!this.rootStart || this.proc.start(this.rootPid) !== this.rootStart) return []
    const children = this.proc.children(this.rootPid)
    const killed = []
    for (const [id, item] of this.items) {
      if (item.turnId !== turnId) continue
      const matches = children.filter(p => p.startMs >= item.at - 2000 && commandMatches(item.command, p, this.platform))
      if (matches.length !== 1) continue // ambiguous or unrecognised: never guess at another thread's shell
      const p = matches[0]
      const start = this.proc.start(p.pid)
      if (start === null) continue
      // Re-query ancestry, command and creation time to prevent pid reuse between lookup and kill.
      const current = this.proc.children(this.rootPid).find(c => c.pid === p.pid)
      if (!current || current.startMs !== p.startMs || this.proc.start(p.pid) !== start || !commandMatches(item.command, current, this.platform)) continue
      killed.push(...this.proc.killTree(p.pid))
      this.items.delete(id)
    }
    return killed
  }
}
