#!/usr/bin/env node
/**
 * 装 team-claude 命令：node bin/install.mjs [--config <配置文件>] [--dir <目录>] [--force]
 *
 * Linux / macOS：写 /usr/local/bin/team-claude；那里不可写时退到 ~/.local/bin。
 * Windows：写 team-claude.cmd（cmd、PowerShell 用）和 team-claude（Git Bash 用）到 npm 全局 bin 目录（见 src/npm-prefix.mjs）。
 * --dir 指定装到哪个目录。装的是一行转发到本仓库 bin/start.mjs 的小脚本，重复跑就是覆盖成指向当前这份仓库。
 * 目标位置已有一个不是本命令装的 team-claude 时不覆盖，除非带 --force。
 *
 * 配置文件：--config，否则装的那一刻环境里的 FEISHU_CHANNEL_CONFIG，都没有就不写。
 * 写进脚本的排在运行时的环境变量和工作目录里的 .feishu-channel/config.json 后面，顺序见 start.mjs。
 * 指定的配置文件不存在就不装。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { HERE } from '../src/common.mjs'
import { defaultConfigFile, INSTALLED_CONFIG_ENV } from '../src/claude-launch.mjs'
import { npmGlobalPrefix } from '../src/npm-prefix.mjs'

const MARK = 'team-claude: feishu-channel-for-claude-code'
const START = resolve(HERE, '..', 'bin', 'start.mjs').replaceAll('\\', '/')
const isWin = process.platform === 'win32'

const argv = process.argv.slice(2)
const force = argv.includes('--force')
function option(name) {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  if (!v || v.startsWith('--')) {
    console.error(`${name} 后面要跟路径`)
    process.exit(1)
  }
  return v
}
const dirArg = option('--dir')
const cfgArg = option('--config') ?? process.env.FEISHU_CHANNEL_CONFIG ?? null
const cfg = cfgArg && resolve(cfgArg)
if (cfg && !existsSync(cfg)) {
  console.error(`配置文件 ${cfg} 不存在（来自 ${option('--config') ? '--config' : '环境变量 FEISHU_CHANNEL_CONFIG'}），没有装。`)
  process.exit(1)
}

// sh：单引号里原样，单引号本身写成 '\''；cmd：% 写成 %%，路径里不会有双引号（Windows 文件名不许）
const shq = p => `'${p.replaceAll("'", "'\\''")}'`
const cmdq = p => p.replaceAll('%', '%%')
const sh = `#!/bin/sh\n# ${MARK}\n${cfg ? `${INSTALLED_CONFIG_ENV}=${shq(cfg)} ` : ''}exec node ${shq(START)} "$@"\n`
const cmd = `@echo off\r\nrem ${MARK}\r\nsetlocal\r\n${cfg ? `set "${INSTALLED_CONFIG_ENV}=${cmdq(cfg)}"\r\n` : ''}node "${cmdq(START)}" %*\r\n`
const files = isWin ? [['team-claude.cmd', cmd], ['team-claude', sh]] : [['team-claude', sh]]

/** 往 dir 里写；目录不可写返回 false，其他错误照抛 */
function tryInstall(dir) {
  for (const [name] of files) {
    const p = join(dir, name)
    if (existsSync(p) && !force && !readFileSync(p, 'utf8').includes(MARK)) {
      console.error(`${p} 已存在，而且不是本命令装的，没有覆盖。确认可以替换就加 --force。`)
      process.exit(1)
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of files) {
      writeFileSync(join(dir, name), body)
      if (!isWin) chmodSync(join(dir, name), 0o755)
    }
    return true
  } catch (e) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) return false
    throw e
  }
}

function npmGlobalBin() {
  const dir = npmGlobalPrefix()
  if (!dir) {
    console.error('拿不到 npm 全局目录（npm_config_prefix、npm config get prefix 都没有结果）。用 --dir 指定一个在 PATH 上的目录。')
    process.exit(1)
  }
  return dir // Windows 上全局 bin 就是 prefix 本身
}

const candidates = dirArg ? [resolve(dirArg)] : isWin ? [npmGlobalBin()] : ['/usr/local/bin', join(homedir(), '.local', 'bin')]
const dir = candidates.find(tryInstall)
if (!dir) {
  console.error(`这些目录都不可写：${candidates.join('、')}。用 --dir 指定一个。`)
  process.exit(1)
}
for (const [name] of files) console.log(`已装 ${join(dir, name)} → ${START}`)
console.log(`配置：${cfg ?? `不写（运行时按环境变量 FEISHU_CHANNEL_CONFIG → 工作目录的 .feishu-channel/config.json → ${defaultConfigFile()} 找）`}`)
if (dir !== candidates[0]) console.log(`${candidates[0]} 不可写，装到了 ${dir}。`)

const norm = p => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
const onPath = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).some(p => norm(p) === norm(dir))
if (!onPath) {
  console.log(isWin
    ? `${dir} 不在 PATH 上：在「系统属性 → 环境变量」里把它加进用户的 Path，重开终端。`
    : `${dir} 不在 PATH 上：在 ~/.bashrc（或你用的 shell 的配置）里加一行 export PATH="${dir}:$PATH"，重开终端。`)
}
console.log('以后在工作目录打 team-claude 就带着飞书 channel 启动（team-claude --new 开新会话）。')
