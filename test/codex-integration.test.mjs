import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(50) }
  assert.fail('integration timeout')
}
test('owned Codex + real daemon + tools-only MCP: whitelist, busy steer, stop, recall, schedule and resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-codex-'))
  const cfgFile = join(dir, 'config.json')
  const cfg = { appId: 'cli_example', appSecret: 'test', allow: ['ou_ok'], stateDir: dir, statusChat: 'oc_group', sweepSec: 0, recallPollSec: 0, scheduleTickSec: 0.05, cardDebounceSec: 0.05, codex: { command: process.execPath, args: [join(root, 'test/fake-codex.mjs')], cwd: dir } }
  writeFileSync(cfgFile, JSON.stringify(cfg))
  writeFileSync(join(dir, 'messages.json'), '[]')
  writeFileSync(join(dir, 'cli_example-seen.txt'), 'om_old')
  const env = { ...process.env, FEISHU_CHANNEL_CONFIG: cfgFile, FEISHU_ADAPTER: join(root, 'test/fake-feishu.mjs'), FAKE: dir,
    FEISHU_TEST_PROCESS_DIR: dir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(join(root, 'test/owned-daemon.mjs')).href}` }
  const read = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : ''
  const calls = () => read('codex.log').trim().split('\n').filter(Boolean).map(JSON.parse)
  const messages = []
  function add(id, content, sender = 'ou_ok') {
    messages.push({ chat_id: 'oc_group', message_id: id, content, msg_type: 'text', sender: { id: sender, sender_type: 'user' } })
    writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages))
    writeFileSync(join(dir, 'fire'), 'oc_group')
  }
  const owned = () => read('owned-processes.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse)
  const alive = pid => {
    try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exit = new Promise(ok => child.once('exit', ok))
    child.kill('SIGTERM')
    const fallback = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await exit } finally { clearTimeout(fallback) }
  }
  let receiver, client, daemon
  const start = () => spawn(process.execPath, [join(root, 'src/codex.mjs'), cfgFile], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  try {
    daemon = spawn(process.execPath, [join(root, 'src/daemon.mjs')], { env, stdio: 'ignore', windowsHide: true })
    await until(() => read('cli_example.log').includes('全量补漏结束'))
    add('om_a1', 'one')
    add('om_a2', 'two')
    add('om_a3', 'three')
    await until(() => (read('cli_example.log').match(/入队/g) ?? []).length >= 3)
    receiver = start()
    let errors = ''
    receiver.stderr.on('data', d => { errors += d })
    await until(() => read('cli_example.log').includes('桥已连上'))
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/bridge.mjs')], env: { ...env, FEISHU_CODEX_TOOLS_ONLY: '1' } })
    client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    await sleep(100)
    await until(() => calls().some(m => m.method === 'turn/start'))
    const merged = calls().find(m => m.method === 'turn/start').params.input[0].text
    assert.match(merged, /om_a1,om_a2,om_a3/)
    add('om_b', 'busy addition')
    await until(() => calls().some(m => m.method === 'turn/steer'))
    add('om_bad', 'ignored', 'ou_bad')
    await sleep(150)
    assert.equal(calls().filter(m => ['turn/start', 'turn/steer'].includes(m.method)).length, 2)
    const reply = await client.callTool({ name: 'reply', arguments: { chat_id: 'oc_group', text: 'reply test' } })
    assert.ok(!reply.isError)
    assert.match(read('sent.txt'), /reply test/)
    add('om_stop', '停')
    await until(() => calls().some(m => m.method === 'turn/interrupt'))
    await until(() => read('cli_example.log').includes('标闲：Stop'))
    add('om_c', 'after stop')
    await until(() => calls().filter(m => m.method === 'turn/start').length === 2)
    writeFileSync(join(dir, 'recall'), 'om_c')
    await until(() => calls().filter(m => m.method === 'turn/interrupt').length === 2)
    await sleep(200)
    await until(() => (read('cli_example.log').match(/标闲：Stop/g) ?? []).length >= 3)
    const schedule = await client.callTool({ name: 'schedule_add', arguments: { kind: 'once', at: new Date(Date.now() + 1000).toISOString(), text: 'scheduled wake' } })
    assert.ok(!schedule.isError)
    await until(() => calls().some(m => JSON.stringify(m.params.input ?? []).includes('scheduled wake')))
    assert.equal(calls().find(m => JSON.stringify(m.params.input ?? []).includes('scheduled wake')).method, 'turn/start')
    await stop(receiver)
    receiver = start()
    receiver.stderr.on('data', d => { errors += d })
    await until(() => calls().some(m => m.method === 'thread/resume'))
    assert.equal(errors, '')
    const rows = owned()
    for (const script of ['codex.mjs', 'bridge.mjs']) {
      const parents = rows.filter(row => row.pid && basename(row.script) === script).map(row => row.pid)
      assert.ok(parents.length > 0 && rows.some(row => row.prevented === 'supervise' && parents.includes(row.parent)), `${script} 的 supervise 启动由测试接管`)
    }
  } catch (error) {
    console.error(read('cli_example.log').slice(-4000))
    throw error
  } finally {
    try {
      await client?.close()
    } finally {
      await stop(receiver)
      await stop(daemon)
      const pids = [...new Set(owned().filter(row => row.pid).map(row => row.pid))]
      assert.ok(pids.includes(daemon?.pid), '真实 daemon 已记录，不能空清单通过')
      for (const script of ['codex.mjs', 'bridge.mjs', 'fake-codex.mjs']) {
        assert.ok(owned().some(row => row.pid && basename(row.script) === script), `${script} 已进入退出检查`)
      }
      await until(() => pids.every(pid => !alive(pid)))
      assert.deepEqual(pids.filter(alive), [], '测试结束后 receiver、MCP bridge、假 Codex 和 daemon 均无残留')
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep) && basename(dir).startsWith('feishu-codex-'))
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
})
