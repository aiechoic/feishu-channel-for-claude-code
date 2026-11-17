#!/usr/bin/env node
// 在配置目录生成 mcp.json 和 settings.json，并打印启动命令
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFile, HERE } from '../src/common.mjs'
import { channelCommand, writeClaudeFiles } from '../src/claude-launch.mjs'

const codexMode = process.argv.includes('--codex')
process.argv = process.argv.filter(a => a !== '--codex')
const cfgFile = configFile()
const dir = dirname(cfgFile)
if (codexMode) {
  // 生成独立片段，不覆盖用户的全局 Codex 配置。
  const toml = `[mcp_servers.feishu]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([join(HERE, 'bridge.mjs')])}\n\n[mcp_servers.feishu.env]\nFEISHU_CHANNEL_CONFIG = ${JSON.stringify(cfgFile)}\nFEISHU_CODEX_TOOLS_ONLY = "1"\n`
  writeFileSync(join(dir, 'codex.config.toml'), toml)
  console.log(`node ${JSON.stringify(join(HERE, 'codex.mjs'))} ${JSON.stringify(cfgFile)}`)
  console.log(`MCP fragment: ${join(dir, 'codex.config.toml')}; session events provide lifecycle reporting, no Claude hooks installed.`)
  process.exit(0)
}
writeClaudeFiles(cfgFile)
console.log(channelCommand(cfgFile))
console.log('装了 team-claude（node bin/install.mjs）的话，以后在工作目录直接打 team-claude。')
