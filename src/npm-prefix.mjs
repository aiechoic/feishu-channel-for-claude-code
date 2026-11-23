/**
 * npm 的全局目录（Windows 上全局 bin 就是它）。
 * 不解析 `npm prefix -g` 的文本输出：新版 npm 会把路径里像 UUID 的段打成 ***，拿去装就 ENOENT。
 * 按顺序取：环境变量 npm_config_prefix → `npm config get prefix --json`（用当前 node 直接跑 npm-cli.js，不走 shell）
 * → Windows 的默认位置 %APPDATA%\npm。都拿不到返回 null。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function npmCliPath(execPath = process.execPath) {
  const dir = dirname(execPath)
  for (const p of [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return p
  }
  return null
}

export function npmGlobalPrefix({ env = process.env, platform = process.platform, execPath = process.execPath, spawnExec = execPath } = {}) {
  if (env.npm_config_prefix) return env.npm_config_prefix
  const cli = npmCliPath(execPath)
  if (cli) {
    const r = spawnSync(spawnExec, [cli, 'config', 'get', 'prefix', '--json'], { encoding: 'utf8', env })
    if (r.status === 0) {
      // --json 时新版 npm 打带引号的字符串，旧版照样打裸路径
      let v = r.stdout.trim()
      try { v = JSON.parse(v) } catch { /* 裸路径 */ }
      if (typeof v === 'string' && v && !v.includes('***')) return v
    }
  }
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'npm')
  return null
}
