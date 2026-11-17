// Claude Code 接这个桥要的两份文件（mcp.json、settings.json）和启动参数：setup.mjs、start.mjs 共用
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { HERE } from './common.mjs'

/** 默认配置文件位置（Windows 上 homedir() 就是 %USERPROFILE%） */
export const defaultConfigFile = () => join(homedir(), '.config', 'feishu-channel', 'config.json')

// 路径一律用正斜杠加双引号：sh、cmd、PowerShell 都认，Node 在 Windows 上也认正斜杠。
const q = p => JSON.stringify(p.replaceAll('\\', '/'))

/** 配置目录里该有的 mcp.json、settings.json 内容（指向本仓库的 bridge.mjs、hook.mjs） */
export function claudeFiles(cfgFile) {
  const dir = dirname(cfgFile)
  // hook 命令：配置文件当参数传，不写 `VAR=… node` 这种只有 sh 认的前缀 —— Windows 上 hook 不一定由 sh 执行。
  const hook = { type: 'command', command: `node ${q(join(HERE, 'hook.mjs'))} ${q(cfgFile)}`, timeout: 5 }
  const plain = [{ hooks: [hook] }]
  const tools = [{ matcher: '*', hooks: [hook] }]
  return {
    mcpFile: join(dir, 'mcp.json'),
    settingsFile: join(dir, 'settings.json'),
    mcp: { mcpServers: { feishu: { command: 'node', args: [join(HERE, 'bridge.mjs')], env: { FEISHU_CHANNEL_CONFIG: cfgFile } } } },
    settings: { hooks: { UserPromptSubmit: plain, Stop: plain, PreToolUse: tools, PostToolUse: tools, PostToolUseFailure: tools } },
  }
}

const sameJson = (file, want) => {
  try {
    return JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) === JSON.stringify(want)
  } catch {
    return false
  }
}

/**
 * 写 mcp.json、settings.json。onlyIfStale 时只重写缺了或内容不一致的（比如指向的是另一份仓库）。
 * 返回重写了的文件路径。
 */
export function writeClaudeFiles(cfgFile, { onlyIfStale = false } = {}) {
  const f = claudeFiles(cfgFile)
  const written = []
  for (const [file, want] of [[f.mcpFile, f.mcp], [f.settingsFile, f.settings]]) {
    if (onlyIfStale && sameJson(file, want)) continue
    writeFileSync(file, JSON.stringify(want, null, 2))
    written.push(file)
  }
  return written
}

/** 接上 channel 的 claude 参数（不含会话相关的） */
export function channelArgs(cfgFile) {
  const f = claudeFiles(cfgFile)
  return ['--mcp-config', f.mcpFile, '--settings', f.settingsFile, '--dangerously-load-development-channels', 'server:feishu']
}

/** 给人看的启动命令（setup.mjs 打印） */
export function channelCommand(cfgFile) {
  const f = claudeFiles(cfgFile)
  return `claude --mcp-config ${q(f.mcpFile)} --settings ${q(f.settingsFile)} --dangerously-load-development-channels server:feishu`
}

/**
 * Claude Code 把会话记在 <配置目录>/projects/<工作目录>/*.jsonl，工作目录名里非字母数字的字符都换成 `-`
 * （/work → -work，C:\Users\a → C--Users-a）。很长的路径会被截断再加后缀，所以按截断后的前缀也认。
 */
export function projectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

const MAX_DIR_NAME = 200

/** 当前目录有没有可以 --continue 的上次会话 */
export function hasPreviousSession(cwd, claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) {
  const root = join(claudeDir, 'projects')
  if (!existsSync(root)) return false
  const name = projectDirName(cwd)
  const candidates = name.length <= MAX_DIR_NAME
    ? [name]
    : readdirSync(root).filter(d => d.startsWith(name.slice(0, MAX_DIR_NAME)))
  return candidates.some(d => {
    const dir = join(root, d)
    try {
      return statSync(dir).isDirectory() && readdirSync(dir).some(f => f.endsWith('.jsonl'))
    } catch {
      return false
    }
  })
}

/** 用户自己带了会话参数时不再加 --continue */
const SESSION_FLAGS = new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session'])

/**
 * team-claude 的参数 → claude 的参数。--new 是 team-claude 自己的（强制开新会话），其余原样透传。
 * 返回 { args, mode }，mode 是 'continue' | 'new' | 'user'（用户自己带了会话参数）。
 */
export function buildArgs(cfgFile, userArgs, { cwd = process.cwd(), claudeDir } = {}) {
  const forceNew = userArgs.includes('--new')
  const rest = userArgs.filter(a => a !== '--new')
  const userSession = rest.some(a => SESSION_FLAGS.has(a.split('=')[0]))
  let mode = 'new'
  if (userSession) mode = 'user'
  else if (!forceNew && hasPreviousSession(cwd, claudeDir)) mode = 'continue'
  return { args: [...channelArgs(cfgFile), ...(mode === 'continue' ? ['--continue'] : []), ...rest], mode }
}

/**
 * 在 PATH 上找 claude。Windows 上原生安装是 claude.exe，npm 安装是 claude.cmd，先找 .exe。
 * 找不到返回 null。
 */
export function findClaude(env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  for (const name of names) {
    for (const d of dirs) {
      const p = join(d, name)
      try {
        if (statSync(p).isFile()) return p
      } catch {}
    }
  }
  return null
}

/**
 * cmd.exe 的一行命令：每个参数加双引号，里面的 `"` 写成 `""`。.cmd 文件只能经 cmd.exe 起，
 * Node 不许直接 spawn 它（CVE-2024-27980 之后），所以自己拼、配 windowsVerbatimArguments。
 */
export function cmdLine(file, args) {
  const quote = s => `"${String(s).replaceAll('"', '""')}"`
  return `"${[file, ...args].map(quote).join(' ')}"`
}
