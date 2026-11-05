#!/usr/bin/env node
// 在配置目录生成 mcp.json 和 settings.json，并打印启动命令
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configFile, HERE } from '../src/common.mjs'

const cfgFile = configFile()
const dir = dirname(cfgFile)
const env = { FEISHU_CHANNEL_CONFIG: cfgFile }
// hook 命令：配置文件当参数传，不写 `VAR=… node` 这种只有 sh 认的前缀 —— Windows 上 hook 不一定由 sh 执行。
// 路径一律用正斜杠加双引号：sh、cmd、PowerShell 都认，Node 在 Windows 上也认正斜杠。
const q = p => JSON.stringify(p.replaceAll('\\', '/'))
const hook = { type: 'command', command: `node ${q(join(HERE, 'hook.mjs'))} ${q(cfgFile)}`, timeout: 5 }
const plain = [{ hooks: [hook] }]
const tools = [{ matcher: '*', hooks: [hook] }]

writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
  mcpServers: { feishu: { command: 'node', args: [join(HERE, 'bridge.mjs')], env } },
}, null, 2))
writeFileSync(join(dir, 'settings.json'), JSON.stringify({
  hooks: { UserPromptSubmit: plain, Stop: plain, PreToolUse: tools, PostToolUse: tools, PostToolUseFailure: tools },
}, null, 2))
console.log(`claude --mcp-config ${q(join(dir, 'mcp.json'))} --settings ${q(join(dir, 'settings.json'))} --dangerously-load-development-channels server:feishu`)
