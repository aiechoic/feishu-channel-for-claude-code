// npm 全局目录：不解析 `npm prefix -g` 的文本（新版 npm 会把像 UUID 的路径段打成 ***）
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { npmGlobalPrefix } from '../src/npm-prefix.mjs'

/** 假的 node 目录：node_modules/npm/bin/npm-cli.js 打印给定内容 */
function fakeNode(stdout) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-prefix-'))
  mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), `process.stdout.write(${JSON.stringify(stdout)})`)
  return dir
}
const run = (dir, env = {}, platform = 'linux') => {
  // execPath 换成假目录里的「node」：用真 node 跑，但让 npmCliPath 在假目录里找 npm-cli.js
  const exe = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
  writeFileSync(exe, '')
  chmodSync(exe, 0o755)
  return npmGlobalPrefix({ env, platform, execPath: exe, spawnExec: process.execPath })
}

test('环境变量 npm_config_prefix 优先', () => {
  assert.equal(npmGlobalPrefix({ env: { npm_config_prefix: 'C:\\Users\\u\\AppData\\Roaming\\npm' } }), 'C:\\Users\\u\\AppData\\Roaming\\npm')
})

test('npm config get prefix --json：带引号的和裸路径都认', () => {
  assert.equal(run(fakeNode('"C:\\\\Users\\\\u\\\\1b2c3d4e-0000-4000-8000-123456789abc\\\\npm"\n')), 'C:\\Users\\u\\1b2c3d4e-0000-4000-8000-123456789abc\\npm')
  assert.equal(run(fakeNode('/usr/local\n')), '/usr/local')
})

test('输出里有 *** 时不用，Windows 退到 %APPDATA%\\npm', () => {
  assert.equal(run(fakeNode('C:\\Users\\u\\***\\npm\n'), { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\u\\AppData\\Roaming', 'npm'))
  assert.equal(run(fakeNode('C:\\Users\\u\\***\\npm\n'), {}, 'linux'), null)
})
