// team-claude（bin/start.mjs、bin/install.mjs）：用假的 claude 可执行文件，不真启动 Claude Code
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildArgs, cmdLine, findClaude, projectDirName } from '../src/claude-launch.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const START = join(ROOT, 'bin', 'start.mjs')
const INSTALL = join(ROOT, 'bin', 'install.mjs')
const isWin = process.platform === 'win32'

/** 一套隔离环境：假 claude、假 HOME、假 Claude 配置目录、工作目录 */
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-claude ')))
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const claudeDir = join(root, 'claude-config')
  const cwd = join(root, 'work dir')
  for (const d of [bin, home, claudeDir, cwd]) mkdirSync(d, { recursive: true })
  const out = join(root, 'claude-called.json')
  const fake = join(bin, 'fake-claude.mjs')
  writeFileSync(fake, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))
process.exit(Number(process.env.FAKE_CODE ?? 0))
`)
  if (isWin) {
    writeFileSync(join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`)
  } else {
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
    chmodSync(join(bin, 'claude'), 0o755)
  }
  const { FEISHU_CHANNEL_CONFIG: _, ...base } = process.env
  const env = { ...base, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeDir, FAKE_OUT: out, PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}` }
  delete env.Path
  const writeConfig = file => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ appId: 'cli_test', allow: ['ou_x'] }))
    return file
  }
  const run = (args = [], extraEnv = {}, script = START) => {
    rmSync(out, { force: true })
    const r = spawnSync(process.execPath, [script, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' })
    return { ...r, called: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null }
  }
  const previousSession = () => {
    const d = join(claudeDir, 'projects', projectDirName(cwd))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'abc.jsonl'), '{}\n')
  }
  return { root, home, cwd, claudeDir, env, writeConfig, run, previousSession, done: () => rmSync(root, { recursive: true, force: true }) }
}

const defaultCfg = home => join(home, '.config', 'feishu-channel', 'config.json')

test('配置查找：有 FEISHU_CHANNEL_CONFIG 用它，没有用 ~/.config/feishu-channel/config.json', () => {
  const t = sandbox()
  try {
    const home = t.writeConfig(defaultCfg(t.home))
    const custom = t.writeConfig(join(t.root, 'other', 'config.json'))

    let r = t.run([], { FEISHU_CHANNEL_CONFIG: custom })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.called.args[1], join(dirname(custom), 'mcp.json'))
    assert.ok(existsSync(join(dirname(custom), 'settings.json')))

    r = t.run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.called.args[1], join(dirname(home), 'mcp.json'))
    assert.equal(r.called.args[3], join(dirname(home), 'settings.json'))
    assert.deepEqual(r.called.args.slice(4, 6), ['--dangerously-load-development-channels', 'server:feishu'])
    assert.equal(r.called.cwd, t.cwd)
  } finally {
    t.done()
  }
})

test('配置找不到：说清楚去哪建，不启动 claude，退出 1', () => {
  const t = sandbox()
  try {
    let r = t.run()
    assert.equal(r.status, 1)
    assert.equal(r.called, null)
    assert.ok(r.stderr.includes(defaultCfg(t.home)), r.stderr)
    assert.match(r.stderr, /config\.example\.json/)

    r = t.run([], { FEISHU_CHANNEL_CONFIG: join(t.root, 'nope.json') })
    assert.equal(r.status, 1)
    assert.equal(r.called, null)
    assert.match(r.stderr, /FEISHU_CHANNEL_CONFIG/)
  } finally {
    t.done()
  }
})

test('mcp.json / settings.json：缺了或指向别的仓库就重新生成，一致时不动', () => {
  const t = sandbox()
  try {
    const cfg = t.writeConfig(defaultCfg(t.home))
    const dir = dirname(cfg)
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { feishu: { command: 'node', args: ['/old/repo/src/bridge.mjs'], env: { FEISHU_CHANNEL_CONFIG: cfg } } } }))

    let r = t.run()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /已重新生成 .*mcp\.json/)
    assert.match(r.stderr, /已重新生成 .*settings\.json/, '缺的 settings.json 也补上')
    const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    assert.deepEqual(mcp.mcpServers.feishu.args, [join(ROOT, 'src', 'bridge.mjs')])
    assert.equal(mcp.mcpServers.feishu.env.FEISHU_CHANNEL_CONFIG, cfg)
    const hook = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
    assert.ok(hook.includes(join(ROOT, 'src', 'hook.mjs').replaceAll('\\', '/')), hook)

    const before = statSync(join(dir, 'mcp.json')).mtimeMs
    r = t.run()
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /已重新生成/)
    assert.equal(statSync(join(dir, 'mcp.json')).mtimeMs, before)
  } finally {
    t.done()
  }
})

test('setup.mjs 与 start.mjs 生成的文件一样（共用一份逻辑）', () => {
  const t = sandbox()
  try {
    const cfg = t.writeConfig(join(t.root, 'cfg', 'config.json'))
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'setup.mjs')], { env: { ...t.env, FEISHU_CHANNEL_CONFIG: cfg }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const s = t.run([], { FEISHU_CHANNEL_CONFIG: cfg })
    assert.equal(s.status, 0, s.stderr)
    assert.doesNotMatch(s.stderr, /已重新生成/)
  } finally {
    t.done()
  }
})

test('--continue：当前目录有上次的会话才带；--new 强制开新会话', () => {
  const t = sandbox()
  try {
    t.writeConfig(defaultCfg(t.home))
    let r = t.run()
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.called.args.includes('--continue'), '没有上次的会话')
    assert.match(r.stderr, /开新会话/)

    t.previousSession()
    r = t.run()
    assert.ok(r.called.args.includes('--continue'))
    assert.match(r.stderr, /接着当前目录上次的会话/)

    r = t.run(['--new'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.called.args.includes('--continue'))
    assert.ok(!r.called.args.includes('--new'), '--new 是 team-claude 自己的，不传给 claude')
  } finally {
    t.done()
  }
})

test('其余参数原样透传；自己带了会话参数时不再加 --continue', () => {
  const t = sandbox()
  try {
    t.writeConfig(defaultCfg(t.home))
    t.previousSession()
    let r = t.run(['--model', 'opus', '--append-system-prompt', 'a "b" c', 'hi there'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(r.called.args.slice(6), ['--continue', '--model', 'opus', '--append-system-prompt', 'a "b" c', 'hi there'])

    for (const flags of [['--resume', 'abc'], ['-r'], ['-c'], ['--session-id=1234']]) {
      r = t.run(flags)
      assert.deepEqual(r.called.args.slice(6), flags, flags.join(' '))
    }
  } finally {
    t.done()
  }
})

test('退出码跟 claude 一致', () => {
  const t = sandbox()
  try {
    t.writeConfig(defaultCfg(t.home))
    const r = t.run([], { FAKE_CODE: '7' })
    assert.equal(r.status, 7)
  } finally {
    t.done()
  }
})

test('PATH 上没有 claude：说清楚，退出 1', () => {
  const t = sandbox()
  try {
    t.writeConfig(defaultCfg(t.home))
    const r = t.run([], { PATH: dirname(process.execPath) })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /PATH 上找不到 claude/)
  } finally {
    t.done()
  }
})

test('install：装到 --dir，重复跑覆盖；别人的 team-claude 不覆盖，--force 才换；装好的命令能起', () => {
  const t = sandbox()
  try {
    t.writeConfig(defaultCfg(t.home))
    const dir = join(t.root, 'install dir')
    const name = isWin ? 'team-claude.cmd' : 'team-claude'
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [INSTALL, '--dir', dir], { env: t.env, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /不在 PATH 上/)
    }
    const body = readFileSync(join(dir, name), 'utf8')
    assert.ok(body.includes(START.replaceAll('\\', '/')), body)
    if (isWin) assert.ok(existsSync(join(dir, 'team-claude')), 'Git Bash 用的那份')
    else assert.ok(statSync(join(dir, name)).mode & 0o111, '可执行')

    writeFileSync(join(dir, name), 'someone else\n')
    let r = spawnSync(process.execPath, [INSTALL, '--dir', dir], { env: t.env, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--force/)
    assert.equal(readFileSync(join(dir, name), 'utf8'), 'someone else\n')
    r = spawnSync(process.execPath, [INSTALL, '--dir', dir, '--force'], { env: t.env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)

    // 装好的命令：参数和退出码都透传
    const out = join(t.root, 'claude-called.json')
    const env = { ...t.env, FAKE_CODE: '3', PATH: `${dirname(process.execPath)}${delimiter}${t.env.PATH}` }
    const run = isWin
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${join(dir, name)}" --model x"`], { cwd: t.cwd, env, encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync(join(dir, name), ['--model', 'x'], { cwd: t.cwd, env, encoding: 'utf8' })
    assert.equal(run.status, 3, run.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).args.slice(-2), ['--model', 'x'])
  } finally {
    t.done()
  }
})

test('会话目录名：非字母数字换成 -', () => {
  assert.equal(projectDirName('/work'), '-work')
  assert.equal(projectDirName('/tmp/claude-0/-work/x'), '-tmp-claude-0--work-x')
  assert.equal(projectDirName('C:\\Users\\a b'), 'C--Users-a-b')
})

test('超长工作目录：按截断后的前缀认上次的会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-claude-long-'))
  try {
    const cwd = `/${'x'.repeat(250)}`
    const d = join(root, 'projects', `${projectDirName(cwd).slice(0, 200)}-h4sh`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 's.jsonl'), '{}\n')
    const { mode } = buildArgs('/c/config.json', [], { cwd, claudeDir: root })
    assert.equal(mode, 'continue')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows：先找 claude.exe 再找 claude.cmd；cmd 命令行的引号', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-claude-find-'))
  try {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(a, 'claude.cmd'), '')
    assert.equal(findClaude({ PATH: `${a};${b}` }, 'win32'), join(a, 'claude.cmd'))
    writeFileSync(join(b, 'claude.exe'), '')
    assert.equal(findClaude({ Path: `${a};${b}` }, 'win32'), join(b, 'claude.exe'), '.exe 优先，哪怕在 PATH 后面')
    assert.equal(findClaude({ PATH: `${a};${b}` }, 'linux'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(cmdLine('C:\\x\\claude.cmd', ['--a', 'b "c"', '']), '""C:\\x\\claude.cmd" "--a" "b ""c""" """')
})
