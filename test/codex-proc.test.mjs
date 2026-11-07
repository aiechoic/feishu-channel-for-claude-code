import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import proc from '../src/proc.mjs'
import { CodexCommands, commandMatches, shellWords, windowsWords } from '../src/codex-proc.mjs'

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
test('real process cleanup kills the owned yielded shell and leaves a sibling shell running', async () => {
  const win = process.platform === 'win32'
  const shell = win ? 'powershell.exe' : 'bash'
  const own = win ? "Write-Output 'codex-owned-example'; Start-Sleep -Seconds 60" : "echo codex-owned-example; sleep 60"
  const other = win ? "Write-Output 'codex-sibling-example'; Start-Sleep -Seconds 60" : "echo codex-sibling-example; sleep 60"
  const args = body => win ? ['-NoProfile', '-Command', body] : ['-lc', body]
  const c = new CodexCommands(proc, process.pid)
  c.observe('item/started', { turnId: 'own', item: { id: 'cmd', type: 'commandExecution', command: `${shell} ${win ? '-NoProfile -Command' : '-lc'} ${quote(own)}` } })
  const child = spawn(shell, args(own), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const sibling = spawn(shell, args(other), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await Promise.all([once(child.stdout, 'data'), once(sibling.stdout, 'data')])
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
