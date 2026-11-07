import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import proc from '../src/proc.mjs'
import { CodexCommands, commandMatches, finalCommand, shellWords, windowsWords } from '../src/codex-proc.mjs'

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
test('shell display and Windows argv parse quotes without evaluating command text', () => {
  const body = "Write-Output 'example';\nStart-Sleep -Seconds 60"
  const display = `powershell.exe -Command ${quote(body)}`
  assert.equal(shellWords(display).at(-1), body)
  assert.deepEqual(windowsWords('"C:\\Program Files\\pwsh.exe" -Command "Write-Output \\"example\\""'), ['C:\\Program Files\\pwsh.exe', '-Command', 'Write-Output "example"'])
  assert.ok(commandMatches(display, { name: 'powershell.exe', cmd: `powershell.exe -Command "try { encoding } catch {}\n${body}"` }, 'win32'))
  assert.ok(!commandMatches(display, { name: 'powershell.exe', cmd: 'powershell.exe -Command "Start-Sleep -Seconds 60"' }, 'win32'))
})
test('stop matches a single current-turn command, retains yielded sessions, refuses ambiguity and stale pid roots', () => {
  let roots = 'root1', rows = [{ pid: 11, startMs: 1100, name: 'powershell.exe', cmd: 'powershell.exe -Command "own command"' }, { pid: 12, startMs: 1100, name: 'powershell.exe', cmd: 'powershell.exe -Command "other command"' }]
  const killed = []
  const fake = { start: pid => pid === 1 ? roots : 'child1', children: () => rows, killTree: pid => { killed.push(pid); return [pid] } }
  const c = new CodexCommands(fake, 1, 'win32', () => 1000)
  const p = { turnId: 'own', item: { id: 'cmd', type: 'commandExecution', command: "powershell.exe -Command 'own command'" } }
  c.observe('item/started', p)
  c.observe('item/completed', { ...p, item: { ...p.item, exitCode: null } })
  assert.deepEqual(c.stop('other'), [])
  rows.push({ ...rows[0], pid: 13 })
  assert.deepEqual(c.stop('own'), [])
  rows.pop()
  roots = 'reused'
  assert.deepEqual(c.stop('own'), [])
  roots = 'root1'
  assert.deepEqual(c.stop('own'), [11])
  assert.deepEqual(killed, [11])
})
test('real process cleanup kills the owned yielded shell and leaves a sibling shell running', { skip: process.platform === 'darwin' && 'macOS 无 /proc 进程归属实现，仅支持原生轮次中断' }, async () => {
  const win = process.platform === 'win32'
  const shell = win ? 'powershell.exe' : 'bash'
  const own = win ? "Write-Output 'codex-owned-example'; Start-Sleep -Seconds 60" : "echo codex-owned-example; sleep 60"
  const other = win ? "Write-Output 'codex-sibling-example'; Start-Sleep -Seconds 60" : "echo codex-sibling-example; sleep 60"
  const args = body => win ? ['-NoProfile', '-Command', body] : ['-lc', body]
  const c = new CodexCommands(proc, process.pid, process.platform, Date.now, { threadId: 'thread_owned' })
  c.observe('item/started', { turnId: 'own', item: { id: 'cmd', type: 'commandExecution', command: `${shell} ${win ? '-NoProfile -Command' : '-lc'} ${quote(own)}` } })
  const child = spawn(shell, args(own), { env: { ...process.env, CODEX_THREAD_ID: 'thread_owned' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const sibling = spawn(shell, args(other), { env: { ...process.env, CODEX_THREAD_ID: 'thread_sibling' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await Promise.all([once(child.stdout, 'data'), once(sibling.stdout, 'data')])
    if (!win) {
      for (let i = 0; i < 100 && [child, sibling].some(p => proc.info(p.pid)?.name !== 'sleep'); i++) await sleep(10)
      assert.equal(proc.info(child.pid)?.name, 'sleep', '真实 bash 已被 exec 为 sleep，不能只测仍是 shell 的情况')
      assert.equal(proc.info(sibling.pid)?.name, 'sleep')
    }
    c.observe('item/completed', { turnId: 'own', item: { id: 'cmd', type: 'commandExecution', command: own, exitCode: null } })
    const exited = once(child, 'exit')
    assert.ok(c.stop('own').includes(child.pid))
    await exited
    assert.equal(sibling.exitCode, null)
    assert.ok(proc.start(sibling.pid))
  } finally {
    for (const p of [child, sibling]) if (p.exitCode === null) proc.killTree(p.pid)
  }
})
test('exec 后要求本线程标识与唯一 argv；缺归属或有歧义时明确记录且不杀', () => {
  const display = "bash -lc 'echo own; sleep 60'"
  assert.deepEqual(finalCommand(display), ['sleep', '60'])
  for (const script of ['sleep $SECONDS', 'sleep 60 | cat', 'exec -a alias sleep 60', 'sleep 60 >out']) {
    assert.deepEqual(finalCommand(`bash -lc ${quote(script)}`), [])
  }
  const row = { pid: 11, startMs: 1100, name: 'sleep', cmd: 'sleep\0' + '60\0' }
  let rows = [row], owner = null
  const killed = [], logs = []
  const fake = { start: () => 'start', children: () => rows, threadId: () => owner, killTree: pid => { killed.push(pid); return [pid] } }
  const c = new CodexCommands(fake, 1, 'linux', () => 1000, { threadId: 'own', report: s => logs.push(s) })
  c.observe('item/started', { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: display } })
  assert.deepEqual(c.stop('turn'), [])
  assert.match(logs.at(-1), /无可验证匹配/)
  owner = 'own'; rows.push({ ...row, pid: 12 })
  assert.deepEqual(c.stop('turn'), [])
  assert.match(logs.at(-1), /歧义/)
  rows.pop()
  assert.deepEqual(c.stop('turn'), [11])
  assert.deepEqual(killed, [11])
})
test('命令没有 item/completed 时由 turn/completed 清掉归属记录', () => {
  const c = new CodexCommands({ start: () => 'root' }, 1)
  c.observe('item/started', { turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: "bash -lc 'sleep 60'" } })
  assert.equal(c.items.size, 1)
  c.observe('turn/completed', { turn: { id: 'turn', status: 'interrupted' } })
  assert.equal(c.items.size, 0)
})
