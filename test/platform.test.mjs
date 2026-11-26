// 平台选择：不认识的 platform 报错；飞书和企业微信的状态文件、本机端点、MCP 名字、启动文件互不相撞
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { channelArgs, claudeFiles } from '../src/claude-launch.mjs'
import { paths } from '../src/common.mjs'
import { accountId, platformOf } from '../src/platform.mjs'

const FEISHU = { appId: 'cli_me', stateDir: '/state' }
const WECOM = { platform: 'wecom', botId: 'bot_example', stateDir: '/state' }

test('platformOf：不写是飞书；写了不认识的值抛错，不回退', () => {
  assert.equal(platformOf({}).name, 'feishu')
  assert.equal(platformOf({ platform: 'wecom' }).name, 'wecom')
  assert.throws(() => platformOf({ platform: 'Feishu' }), /不认识的 platform/)
  assert.throws(() => platformOf({ platform: '' }), /不认识的 platform/)
  assert.equal(accountId(FEISHU), 'cli_me')
  assert.equal(accountId(WECOM), 'bot_example')
})

test('同一个状态目录里飞书和企业微信的状态文件、Unix socket、Windows 命名管道全都不一样；飞书的路径和原来一样', () => {
  for (const os of ['linux', 'win32']) {
    const f = paths(FEISHU, os)
    const w = paths(WECOM, os)
    const fv = Object.entries(f).filter(([k]) => !['dir', 'pipe'].includes(k)).map(([, v]) => v)
    const wv = Object.entries(w).filter(([k]) => !['dir', 'pipe'].includes(k)).map(([, v]) => v)
    for (const v of wv) assert.ok(!fv.includes(v), `${os} 撞了：${v}`)
  }
  // 同一个 id 字符串也不撞（企业微信带 wecom- 前缀）
  const same = paths({ ...WECOM, botId: 'cli_me' })
  assert.notEqual(same.sock, paths(FEISHU).sock)
  assert.equal(paths(FEISHU, 'linux').sock, join('/state', 'cli_me.sock'))
  assert.equal(paths(FEISHU, 'linux').state, join('/state', 'cli_me-state.json'))
  assert.match(paths(FEISHU, 'win32').sock, /^\\\\\.\\pipe\\feishu-channel-cli_me-[0-9a-f]{12}$/)
  assert.match(paths(WECOM, 'win32').sock, /^\\\\\.\\pipe\\wecom-channel-bot_example-[0-9a-f]{12}$/)
})

test('启动文件：MCP server 名字按平台（feishu / wecom），两份配置放在同一个目录时 mcp.json、settings.json 也不互相覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-'))
  try {
    const f = join(dir, 'config.json')
    const w = join(dir, 'wecom.json')
    writeFileSync(f, JSON.stringify(FEISHU))
    writeFileSync(w, JSON.stringify(WECOM))
    const a = claudeFiles(f)
    const b = claudeFiles(w)
    assert.deepEqual(Object.keys(a.mcp.mcpServers), ['feishu'])
    assert.deepEqual(Object.keys(b.mcp.mcpServers), ['wecom'])
    assert.equal(a.mcpFile, join(dir, 'mcp.json'))
    assert.equal(a.settingsFile, join(dir, 'settings.json'))
    assert.notEqual(a.mcpFile, b.mcpFile)
    assert.notEqual(a.settingsFile, b.settingsFile)
    assert.equal(channelArgs(f).at(-1), 'server:feishu')
    assert.equal(channelArgs(w).at(-1), 'server:wecom')
    // 配置文件还不存在时按飞书（setup 可以先打印命令）
    assert.equal(channelArgs(join(dir, 'none.json')).at(-1), 'server:feishu')
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ platform: 'slack' }))
    assert.throws(() => claudeFiles(join(dir, 'bad.json')), /不认识的 platform/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
