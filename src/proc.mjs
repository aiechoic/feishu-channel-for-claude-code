/**
 * 进程表：按平台查子进程、杀进程树、取进程启动时刻。常驻进程（「停」杀当前工具）和定时（等进程结束）用。
 *
 * Linux 读 /proc；Windows 用 PowerShell 的 Get-CimInstance Win32_Process 查、taskkill /T /F 杀树。
 * 两边都只在用到时查（「停」、撤回打断、忙时心跳超时、process 定时到点检查），不常驻轮询。
 * makeProc 可注入平台和命令执行器，单测在任何平台上都能覆盖两边的解析。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })

/** Claude Code 的 Bash 工具起的 shell：Linux 上是 sh / bash / zsh / dash；Windows 上是 Git Bash 的 bash.exe */
export const SHELL_NAME = /^(ba|z|da)?sh(\.exe)?$/i

/**
 * @param {object} [o]
 * @param {string} [o.platform] 缺省 process.platform
 * @param {(cmd: string, args: string[]) => string} [o.exec] 执行外部命令、返回 stdout（Windows 用；单测注入假输出）
 * @param {(file: string) => string} [o.read] 读文件（Linux 用；单测注入假 /proc）
 * @param {() => string[]} [o.list] 列 /proc 目录（Linux 用）
 * @param {(pid: number, sig: string) => void} [o.kill] 发信号（Linux 用）
 */
export function makeProc(o = {}) {
  const platform = o.platform ?? process.platform
  return platform === 'win32' ? windows(o.exec ?? run) : linux(o)
}

// ---------- Linux ----------

function linux(o) {
  const read = o.read ?? (f => readFileSync(f, 'utf8'))
  const list = o.list ?? (() => readdirSync('/proc'))
  const kill = o.kill ?? ((pid, sig) => process.kill(pid, sig))

  /** /proc/<pid>/stat → { pid, ppid, name, start }；start 是开机后的时钟滴答（第 22 列） */
  function stat(pid) {
    const s = read(`/proc/${pid}/stat`)
    const close = s.lastIndexOf(')')
    const f = s.slice(close + 2).split(' ')
    return { pid, name: s.slice(s.indexOf('(') + 1, close), ppid: Number(f[1]), start: f[19] }
  }

  function table() {
    const rows = []
    for (const name of list()) {
      if (!/^\d+$/.test(name)) continue
      try {
        rows.push(stat(Number(name)))
      } catch {
        // 进程刚退出
      }
    }
    return rows
  }

  const cmdline = pid => {
    try {
      return read(`/proc/${pid}/cmdline`)
    } catch {
      return ''
    }
  }

  return {
    /** ppid 的子进程：{ pid, name, startMs, cmd } */
    children(ppid) {
      const boot = Number(/^btime (\d+)/m.exec(read('/proc/stat'))[1]) * 1000
      return table().filter(p => p.ppid === ppid)
        .map(p => ({ pid: p.pid, name: p.name, startMs: boot + Number(p.start) * 10, cmd: cmdline(p.pid) }))
    },
    /** 先 SIGTERM，2 秒后 SIGKILL；返回整棵树的 pid */
    killTree(root) {
      const rows = table()
      const tree = [root]
      for (let i = 0; i < tree.length; i++) tree.push(...rows.filter(p => p.ppid === tree[i]).map(p => p.pid))
      const send = sig => tree.forEach(pid => {
        try {
          kill(pid, sig)
        } catch {
          // 已退出
        }
      })
      send('SIGTERM')
      setTimeout(() => send('SIGKILL'), 2000).unref()
      return tree
    },
    /** 认进程用的启动时刻（防 pid 复用），进程不在返回 null */
    start(pid) {
      try {
        return stat(pid).start
      } catch {
        return null
      }
    },
  }
}

// ---------- Windows ----------

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Win32_Process 的 CreationDate：ConvertTo-Json 出 "/Date(ms)/"，也收 ISO 和 CIM 的 yyyymmddHHMMSS.ffffff±UUU */
export function parseWinDate(v) {
  if (v == null) return NaN
  const s = String(v)
  const ms = /\/Date\((-?\d+)/.exec(s)
  if (ms) return Number(ms[1])
  const cim = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-]\d{3})$/.exec(s)
  if (cim) {
    const [, y, mo, d, h, mi, se, f, off] = cim
    return Date.UTC(+y, mo - 1, +d, +h, +mi, +se, +f) - Number(off) * 60_000
  }
  return Date.parse(s)
}

function windows(exec) {
  /** filter 是 WQL 条件，只拼数字进去 */
  function query(filter) {
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,Name,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine | ConvertTo-Json -Compress`
    let out
    try {
      out = exec('powershell.exe', [...PS, script]).trim()
    } catch {
      return []
    }
    if (!out) return []
    const rows = JSON.parse(out)
    return (Array.isArray(rows) ? rows : [rows]).map(r => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      name: r.Name ?? '',
      startMs: parseWinDate(r.Created),
      cmd: r.CommandLine ?? '',
    }))
  }

  return {
    children(ppid) {
      return query(`ParentProcessId=${Number(ppid)}`).map(({ pid, name, startMs, cmd }) => ({ pid, name, startMs, cmd }))
    },
    /** taskkill /T 连子孙一起杀，/F 强制（Windows 没有可以让工具收尾的温和信号）；返回列出的树 */
    killTree(root) {
      const tree = [root]
      for (let i = 0; i < tree.length && i < 200; i++) tree.push(...query(`ParentProcessId=${Number(tree[i])}`).map(p => p.pid))
      try {
        exec('taskkill.exe', ['/PID', String(root), '/T', '/F'])
      } catch {
        // 已退出
      }
      return tree
    },
    start(pid) {
      const [p] = query(`ProcessId=${Number(pid)}`)
      return p && Number.isFinite(p.startMs) ? String(p.startMs) : null
    },
  }
}

const proc = makeProc()
export default proc
