// 仅供集成测试预载：daemon 由测试持有，不允许 receiver/bridge 脱离测试再起 supervise。
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.env.FEISHU_TEST_PROCESS_DIR
if (!dir) throw new Error('测试进程记录目录未指定')
const record = value => appendFileSync(join(dir, 'owned-processes.jsonl'), JSON.stringify(value) + '\n')
record({ pid: process.pid, script: process.argv[1] })
const supervise = fileURLToPath(new URL('../src/supervise.mjs', import.meta.url))
const spawn = childProcess.spawn
childProcess.spawn = function (command, args, options) {
  if (command === process.execPath && args?.[0] && resolve(args[0]) === supervise) {
    record({ prevented: 'supervise', parent: process.pid })
    return { unref() { return this } }
  }
  return spawn.call(this, command, args, options)
}
syncBuiltinESMExports()
