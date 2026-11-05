#!/usr/bin/env node
// 自检：node bin/doctor.mjs。核心权限缺失时退出码 1，其余只报告。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readConfig } from '../src/common.mjs'
import { checkScopes, report } from '../src/doctor.mjs'

const cfg = readConfig()
// 绝对路径转成 file URL 再 import：Windows 的 C:\… 直接 import 会报错
const { connect } = await import(process.env.FEISHU_ADAPTER ? pathToFileURL(process.env.FEISHU_ADAPTER).href : '../src/feishu.mjs')
const expected = cfg.expectedScopesFile ? JSON.parse(readFileSync(cfg.expectedScopesFile, 'utf8')) : cfg.expectedScopes
const f = connect(cfg, console.log)
const granted = await f.grantedScopes()
const r = checkScopes(granted, expected)
console.log(`已开通 ${granted.length} 项权限`)
console.log(report(r, expected))
if (r.coreMissing.length) {
  console.log(`核心权限缺失：${r.coreMissing.map(n => n.feature).join('、')}，无法启动`)
  process.exit(1)
}
