#!/usr/bin/env node
/**
 * team-claude：带上飞书 channel 启动 Claude Code。
 *
 *   team-claude            当前目录有上次的会话就接着（--continue），没有就开新的
 *   team-claude --new      强制开新会话
 *   team-claude <其他参数>  原样传给 claude；自己带了 -c / -r / --resume / --session-id 时不再加 --continue
 *
 * 配置文件，按顺序：环境变量 FEISHU_CHANNEL_CONFIG → 当前目录往上的 .feishu-channel/config.json
 * → install 时 --config 写进去的 → ~/.config/feishu-channel/config.json。启动时打印用的是哪份、从哪来。
 * 配置目录里的 mcp.json、settings.json 缺了或指向的不是这份仓库，启动前重新生成。
 * 退出码跟 claude 一致；配置或 claude 找不到时退出 1。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { buildArgs, cmdLine, findClaude, INSTALLED_CONFIG_ENV, resolveConfig, SOURCE_LABEL, writeClaudeFiles } from '../src/claude-launch.mjs'

const say = s => process.stderr.write(`team-claude: ${s}\n`)

const { file: cfgFile, source } = resolveConfig()
if (!existsSync(cfgFile)) {
  say(`找不到配置文件 ${cfgFile}（来源：${SOURCE_LABEL[source]}）`)
  say({
    env: '改环境变量 FEISHU_CHANNEL_CONFIG 指到实际的配置文件，或去掉它。',
    installed: '安装时 --config 指的文件不在了：重跑 node bin/install.mjs --config <配置文件>。',
    default: '照本仓库的 config.example.json 建一份：放在工作目录的 .feishu-channel/config.json（一台机器几个机器人时用这个），或者这个默认位置；字段见 README「配置」。',
  }[source])
  process.exit(1)
}
say(`配置：${cfgFile}（来源：${SOURCE_LABEL[source]}）`)

for (const f of writeClaudeFiles(cfgFile, { onlyIfStale: true })) say(`已重新生成 ${f}`)

const claude = findClaude()
if (!claude) {
  say('PATH 上找不到 claude（Windows 上找 claude.exe、claude.cmd）。先装 Claude Code，或把它所在目录加进 PATH。')
  process.exit(1)
}

const { args, mode } = buildArgs(cfgFile, process.argv.slice(2))
delete process.env[INSTALLED_CONFIG_ENV] // 只给这一层用，不传给 claude 里再起的命令
say({ continue: '接着当前目录上次的会话', new: '开新会话', user: '会话参数按你给的' }[mode])

// .cmd 只能经 cmd.exe 起
const child = process.platform === 'win32' && claude.toLowerCase().endsWith('.cmd')
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmdLine(claude, args)], { stdio: 'inherit', windowsVerbatimArguments: true })
  : spawn(claude, args, { stdio: 'inherit' })

// Ctrl-C 终端会发给整个前台进程组，claude 自己收到；这里不转（转了就成了按两下，claude 会退出）。
// SIGTERM / SIGHUP 可能只发给这一层，转给 claude。
process.on('SIGINT', () => {})
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))

child.on('error', e => {
  say(`起不来 ${claude}：${e.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
