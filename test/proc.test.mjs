import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paths } from '../src/common.mjs'
import { COMMAND_TOOLS, isCommandShell, makeProc, parseWinDate, SHELL_NAME } from '../src/proc.mjs'

// 进程表两边的解析：Linux 喂假 /proc，Windows 喂假 PowerShell / taskkill 输出，在任何平台上都跑

test('Linux：按 /proc 列子进程、算启动时刻、杀整棵树', () => {
  const stat = { 10: '10 (claude) S 1 x', 20: '20 (bash) S 10', 21: '21 (sleep) S 20', 30: '30 (node) S 10' }
  const line = (pid, rest) => {
    const [head, ppid] = rest.split(' S ')
    // 第 22 列是开机后的滴答数：pid 20 → 500 滴答（5 秒）
    const f = ['S', ppid.split(' ')[0], ...Array(17).fill('0'), String(pid * 25)]
    return `${head} ${f.join(' ')} 0 0`
  }
  const files = {
    '/proc/stat': 'cpu 1 2 3\nbtime 1700000000\n',
    '/proc/20/cmdline': 'bash\0-c\0sleep 300',
    '/proc/30/cmdline': 'node\0/x/hook.mjs',
    '/proc/21/cmdline': 'sleep\0' + '300\0',
    '/proc/21/environ': 'OTHER=example\0CODEX_THREAD_ID=thread_example\0SECRET=not-returned\0',
  }
  for (const [pid, s] of Object.entries(stat)) files[`/proc/${pid}/stat`] = line(Number(pid), s)
  const killed = []
  const p = makeProc({
    platform: 'linux',
    read: f => { if (!(f in files)) throw new Error('ENOENT'); return files[f] },
    list: () => ['self', '10', '20', '21', '30'],
    kill: (pid, sig) => killed.push(`${sig}:${pid}`),
  })
  const kids = p.children(10)
  assert.deepEqual(kids.map(k => [k.pid, k.name]), [[20, 'bash'], [30, 'node']])
  assert.equal(kids[0].startMs, 1700000000_000 + 500 * 10)
  assert.match(kids[1].cmd, /hook\.mjs/)
  assert.deepEqual(p.descendants(10).map(p => p.pid), [20, 30, 21])
  assert.equal(p.threadId(21), 'thread_example')
  assert.equal(p.threadId(99), null)
  assert.deepEqual(p.killTree(20), [20, 21])
  assert.deepEqual(killed, ['SIGTERM:20', 'SIGTERM:21'])
  assert.equal(p.start(20), '500')
  assert.equal(p.start(99), null)
})

test('Windows：Get-CimInstance 的 JSON 解析成子进程，taskkill /T /F 杀树', () => {
  const calls = []
  const rows = {
    'ParentProcessId=10': [
      { ProcessId: 20, ParentProcessId: 10, Name: 'bash.exe', Created: '2026-11-05T01:00:05.0000000Z', CommandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "npm test"' },
      { ProcessId: 30, ParentProcessId: 10, Name: 'node.exe', Created: '2026-11-05T01:00:06.0000000Z', CommandLine: 'node "C:/x/hook.mjs" "C:/cfg.json"' },
    ],
    // 只有一行时 ConvertTo-Json 给的是对象不是数组
    'ParentProcessId=20': { ProcessId: 21, ParentProcessId: 20, Name: 'bash.exe', Created: '2026-11-05T01:00:05.1000000Z', CommandLine: 'bash' },
    'ParentProcessId=21': null,
    'ProcessId=20': { ProcessId: 20, ParentProcessId: 10, Name: 'bash.exe', Created: '/Date(1793840405000)/', CommandLine: '' },
  }
  const p = makeProc({
    platform: 'win32',
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'taskkill.exe') return ''
      const filter = /-Filter '([^']+)'/.exec(args.at(-1))[1]
      return filter in rows && rows[filter] ? JSON.stringify(rows[filter]) : ''
    },
  })
  const kids = p.children(10)
  assert.deepEqual(kids.map(k => [k.pid, k.name]), [[20, 'bash.exe'], [30, 'node.exe']])
  assert.equal(kids[0].startMs, Date.parse('2026-11-05T01:00:05Z'))
  assert.ok(SHELL_NAME.test(kids[0].name), 'Git Bash 的 bash.exe 算工具 shell')
  assert.ok(!SHELL_NAME.test(kids[1].name))
  assert.match(calls[0], /^powershell\.exe .*Get-CimInstance Win32_Process -Filter 'ParentProcessId=10'/)

  assert.deepEqual(p.killTree(20), [20, 21])
  assert.ok(calls.includes('taskkill.exe /PID 20 /T /F'))
  assert.equal(p.start(20), String(1793840405000))
  assert.equal(p.start(99), null)
})

test('Windows：PowerShell 跑不起来时当没有进程，不抛', () => {
  const p = makeProc({ platform: 'win32', exec: () => { throw new Error('not found') } })
  assert.deepEqual(p.children(1), [])
  assert.equal(p.start(1), null)
  assert.deepEqual(p.killTree(5), [5])
})

test('Windows 的时间格式：/Date(ms)/、ISO、CIM 原样', () => {
  assert.equal(parseWinDate('/Date(1700000000123)/'), 1700000000123)
  assert.equal(parseWinDate('2026-11-05T01:00:05.5Z'), Date.parse('2026-11-05T01:00:05.5Z'))
  // CIM：本地时间 + 分钟偏移，+480 是东八区
  assert.equal(parseWinDate('20261105090005.500000+480'), Date.parse('2026-11-05T01:00:05.5Z'))
  assert.ok(Number.isNaN(parseWinDate(null)))
})

test('本机端点：Linux 是状态目录里的 socket 文件；Windows 是带状态目录哈希的命名管道', () => {
  const linux = paths({ appId: 'cli_a', stateDir: '/s/one' }, 'linux')
  assert.equal(linux.pipe, false)
  assert.match(linux.sock, /cli_a\.sock$/)
  assert.match(linux.superSock, /cli_a-supervise\.sock$/)
  const a = paths({ appId: 'cli_a', stateDir: 'C:\\s\\one' }, 'win32')
  const b = paths({ appId: 'cli_a', stateDir: 'C:\\s\\two' }, 'win32')
  assert.equal(a.pipe, true)
  assert.match(a.sock, /^\\\\\.\\pipe\\feishu-channel-cli_a-[0-9a-f]{12}$/)
  assert.equal(a.superSock, `${a.sock}-supervise`)
  assert.notEqual(a.sock, b.sock, '两个状态目录不能撞名')
  assert.equal(paths({ appId: 'cli_a', stateDir: 'c:\\S\\One' }, 'win32').sock, a.sock, 'Windows 路径不分大小写')
})

test('跑命令的工具：Bash 和 PowerShell；认得出它们起的 shell', () => {
  assert.ok(COMMAND_TOOLS.has('Bash') && COMMAND_TOOLS.has('PowerShell'))
  assert.ok(!COMMAND_TOOLS.has('Read'))
  for (const name of ['bash', 'sh', 'zsh', 'dash', 'bash.exe', 'powershell.exe', 'PowerShell.EXE', 'pwsh.exe', 'pwsh'])
    assert.ok(SHELL_NAME.test(name), name)
  for (const name of ['node.exe', 'conhost.exe', 'cmd.exe', 'claude.exe', 'bashful', 'powershell_ise.exe'])
    assert.ok(!SHELL_NAME.test(name), name)
})

test('Windows：PowerShell 工具起的 powershell.exe 是工具进程，taskkill 杀它的树', () => {
  const calls = []
  const rows = {
    'ParentProcessId=10': [
      { ProcessId: 40, ParentProcessId: 10, Name: 'powershell.exe', Created: '2026-11-05T08:50:00.0000000Z', CommandLine: 'powershell.exe -NoProfile -Command "npm test"' },
      { ProcessId: 41, ParentProcessId: 10, Name: 'pwsh.exe', Created: '2026-11-05T08:50:01.0000000Z', CommandLine: 'pwsh.exe -Command "Start-Sleep 300"' },
    ],
    'ParentProcessId=40': { ProcessId: 42, ParentProcessId: 40, Name: 'node.exe', Created: '2026-11-05T08:50:00.5000000Z', CommandLine: 'node test' },
  }
  const p = makeProc({
    platform: 'win32',
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'taskkill.exe') return ''
      const filter = /-Filter '([^']+)'/.exec(args.at(-1))[1]
      return rows[filter] ? JSON.stringify(rows[filter]) : ''
    },
  })
  const shells = p.children(10).filter(k => SHELL_NAME.test(k.name))
  assert.deepEqual(shells.map(k => k.pid), [40, 41])
  assert.deepEqual(p.killTree(40), [40, 42])
  assert.ok(calls.includes('taskkill.exe /PID 40 /T /F'))
})

// 运维在 Windows 上量到的真实进程链：claude.exe 26696 → cmd.exe 20476 → powershell.exe 27508
const PS_CMD = 'cmd.exe /d /s /c ""chcp.com" 65001 >nul & "powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$__claudeCodeScript = \'Start-Sleep 300\'""'
const PS_CHILD = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$__claudeCodeScript = \'Start-Sleep 300\'"'

test('PowerShell 工具外面那层 cmd.exe 算前台命令进程；别的 cmd.exe 不算', () => {
  assert.ok(isCommandShell({ name: 'cmd.exe', cmd: PS_CMD }))
  assert.ok(isCommandShell({ name: 'cmd.exe', cmd: 'cmd.exe /c C:\\Program Files\\PowerShell\\7\\pwsh.exe -c x' }))
  assert.ok(isCommandShell({ name: 'CMD.EXE', cmd: 'C:\\Windows\\system32\\cmd.exe /c "powershell" -c x' }))
  assert.ok(isCommandShell({ name: 'bash.exe', cmd: '' }), 'Bash 工具照旧')
  assert.ok(!isCommandShell({ name: 'cmd.exe', cmd: 'cmd.exe /d /s /c "node "C:/x/hook.mjs" "C:/cfg.json""' }))
  assert.ok(!isCommandShell({ name: 'cmd.exe', cmd: 'cmd.exe /c type powershell_notes.txt' }))
  assert.ok(!isCommandShell({ name: 'cmd.exe', cmd: 'cmd.exe /c echo mypowershell.exe.txt' }))
  assert.ok(!isCommandShell({ name: 'node.exe', cmd: 'node powershell.exe' }))
})

test('Windows：claude → cmd.exe → powershell.exe，找到 cmd.exe 并从它起 taskkill /T 杀树', () => {
  const calls = []
  const rows = {
    'ParentProcessId=26696': [
      { ProcessId: 20476, ParentProcessId: 26696, Name: 'cmd.exe', Created: '2026-11-05T09:10:00.0000000Z', CommandLine: PS_CMD },
      { ProcessId: 20500, ParentProcessId: 26696, Name: 'cmd.exe', Created: '2026-11-05T09:10:00.2000000Z', CommandLine: 'cmd.exe /d /s /c "node "C:/x/hook.mjs" "C:/cfg.json""' },
      { ProcessId: 20600, ParentProcessId: 26696, Name: 'node.exe', Created: '2026-11-05T09:09:00.0000000Z', CommandLine: 'node C:/x/bridge.mjs' },
    ],
    'ParentProcessId=20476': [
      { ProcessId: 20480, ParentProcessId: 20476, Name: 'chcp.com', Created: '2026-11-05T09:10:00.0100000Z', CommandLine: 'chcp.com 65001' },
      { ProcessId: 27508, ParentProcessId: 20476, Name: 'powershell.exe', Created: '2026-11-05T09:10:00.1000000Z', CommandLine: PS_CHILD },
    ],
    'ParentProcessId=27508': { ProcessId: 27600, ParentProcessId: 27508, Name: 'node.exe', Created: '2026-11-05T09:10:01.0000000Z', CommandLine: 'node test' },
  }
  const p = makeProc({
    platform: 'win32',
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'taskkill.exe') return ''
      const filter = /-Filter '([^']+)'/.exec(args.at(-1))[1]
      return rows[filter] ? JSON.stringify(rows[filter]) : ''
    },
  })
  const tools = p.children(26696).filter(k => isCommandShell(k) && !k.cmd.includes('hook.mjs'))
  assert.deepEqual(tools.map(k => k.pid), [20476], '只认 PowerShell 外面那层 cmd.exe')
  assert.deepEqual(p.killTree(20476), [20476, 20480, 27508, 27600])
  assert.ok(calls.includes('taskkill.exe /PID 20476 /T /F'))
})
