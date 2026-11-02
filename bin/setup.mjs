#!/usr/bin/env node
// 在配置目录生成 mcp.json 和 settings.json，并打印启动命令
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HERE } from '../src/common.mjs'

const cfgFile = process.env.FEISHU_CHANNEL_CONFIG ?? join(homedir(), '.config', 'feishu-channel', 'config.json')
const dir = dirname(cfgFile)
const env = { FEISHU_CHANNEL_CONFIG: cfgFile }
const prefix = `FEISHU_CHANNEL_CONFIG=${JSON.stringify(cfgFile)} `
const hook = { type: 'command', command: `${prefix}node ${JSON.stringify(join(HERE, 'hook.mjs'))}`, timeout: 5 }
const plain = [{ hooks: [hook] }]
const tools = [{ matcher: '*', hooks: [hook] }]

writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
  mcpServers: { feishu: { command: 'node', args: [join(HERE, 'bridge.mjs')], env } },
}, null, 2))
writeFileSync(join(dir, 'settings.json'), JSON.stringify({
  hooks: { UserPromptSubmit: plain, Stop: plain, PreToolUse: tools, PostToolUse: tools, PostToolUseFailure: tools },
}, null, 2))
console.log(`claude --mcp-config ${join(dir, 'mcp.json')} --settings ${join(dir, 'settings.json')} --dangerously-load-development-channels server:feishu`)
