import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { paths } from '../src/common.mjs'

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
  const env = { ...process.env, FEISHU_CHANNEL_CONFIG: cfgFile, FEISHU_ADAPTER: join(root, 'test/fake-feishu.mjs'), FAKE: dir }
  const read = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : ''
  const calls = () => read('codex.log').trim().split('\n').filter(Boolean).map(JSON.parse)
  const messages = []
  function add(id, content, sender = 'ou_ok') {
    messages.push({ chat_id: 'oc_group', message_id: id, content, msg_type: 'text', sender: { id: sender, sender_type: 'user' } })
    writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages))
    writeFileSync(join(dir, 'fire'), 'oc_group')
  }
  let receiver, client, supervisor
  const start = () => spawn(process.execPath, [join(root, 'src/codex.mjs'), cfgFile], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  try {
    supervisor = spawn(process.execPath, [join(root, 'src/supervise.mjs')], { env, stdio: 'ignore', windowsHide: true })
    await until(() => read('cli_example.log').includes('常驻进程启动'))
    receiver = start()
    let errors = ''
    receiver.stderr.on('data', d => { errors += d })
    await until(() => read('cli_example.log').includes('桥已连上'))
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/bridge.mjs')], env: { ...env, FEISHU_CODEX_TOOLS_ONLY: '1' } })
    client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    await sleep(100)
    add('om_a', 'hello')
    await until(() => calls().some(m => m.method === 'turn/start'))
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
    // Complete the fake turn created for the recall notice, then schedule while idle.
    const peer = connect(paths(cfg).sock)
    peer.on('error', () => {})
    peer.end(JSON.stringify({ t: 'hook', event: 'Stop' }) + '\n')
    const schedule = await client.callTool({ name: 'schedule_add', arguments: { kind: 'once', at: new Date(Date.now() + 1000).toISOString(), text: 'scheduled wake' } })
    assert.ok(!schedule.isError)
    await until(() => calls().some(m => JSON.stringify(m.params.input ?? []).includes('scheduled wake')))
    receiver.kill()
    await new Promise(ok => receiver.once('exit', ok))
    receiver = start()
    receiver.stderr.on('data', d => { errors += d })
    await until(() => calls().some(m => m.method === 'thread/resume'))
    assert.equal(errors, '')
  } finally {
    await client?.close()
    receiver?.kill()
    if (receiver && receiver.exitCode === null) await new Promise(ok => receiver.once('exit', ok))
    supervisor?.kill('SIGKILL')
    try { process.kill(JSON.parse(read('cli_example.pid')).pid, 'SIGKILL') } catch {}
    await sleep(300)
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
