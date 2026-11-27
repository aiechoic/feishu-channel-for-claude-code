// 平台选择：不认识的 platform 报错；飞书和企业微信的状态文件、本机端点、MCP 名字、启动文件互不相撞
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { channelArgs, channelCommand, claudeFiles, launchFiles, writeClaudeFiles } from '../src/claude-launch.mjs'
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

test('一个会话接两个 channel：主配置写 withConfigs，mcp 文件各自一份、hook 合进 channels-settings.json、开发 channel 给两个 server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-'))
  try {
    const f = join(dir, 'config.json')
    const w = join(dir, 'wecom.json')
    writeFileSync(f, JSON.stringify({ ...FEISHU, withConfigs: ['wecom.json', 'config.json'] }))
    writeFileSync(w, JSON.stringify(WECOM))
    const l = launchFiles(f)
    assert.deepEqual(l.configs, [f, w], '同平台的（自己）不重复接')
    assert.deepEqual(l.servers, ['feishu', 'wecom'])
    assert.deepEqual(l.mcpFiles, [join(dir, 'mcp.json'), join(dir, 'wecom-mcp.json')])
    assert.equal(l.settingsFile, join(dir, 'channels-settings.json'))
    const args = channelArgs(f)
    assert.deepEqual(args, ['--mcp-config', join(dir, 'mcp.json'), join(dir, 'wecom-mcp.json'), '--settings', join(dir, 'channels-settings.json'), '--dangerously-load-development-channels', 'server:feishu', 'server:wecom'])
    assert.match(channelCommand(f), /server:feishu server:wecom$/)
    writeClaudeFiles(f)
    const settings = JSON.parse(readFileSync(join(dir, 'channels-settings.json'), 'utf8'))
    for (const event of ['UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const cmds = settings.hooks[event].flatMap(h => h.hooks.map(x => x.command))
      assert.equal(cmds.length, 2, event)
      assert.ok(cmds[0].endsWith('config.json"') && cmds[1].endsWith('wecom.json"'), cmds.join(' | '))
    }
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'wecom-mcp.json'), 'utf8')).mcpServers), ['wecom'])
    // 单独接企业微信的那份不受影响
    assert.deepEqual(channelArgs(w), ['--mcp-config', join(dir, 'wecom-mcp.json'), '--settings', join(dir, 'wecom-settings.json'), '--dangerously-load-development-channels', 'server:wecom'])
    // 列的文件不在：报错
    writeFileSync(f, JSON.stringify({ ...FEISHU, withConfigs: ['nope.json'] }))
    assert.throws(() => channelArgs(f), /withConfigs.*不存在/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
