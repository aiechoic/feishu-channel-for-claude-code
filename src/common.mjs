// 常驻进程、桥、hook 共用：读配置、算状态文件路径
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))

export function readConfig() {
  const file = process.env.FEISHU_CHANNEL_CONFIG ?? join(homedir(), '.config', 'feishu-channel', 'config.json')
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (!cfg.appId || !cfg.allow?.length) throw new Error(`${file} 缺 appId 或 allow`)
  return cfg
}

export function paths(cfg) {
  const dir = cfg.stateDir ?? join(homedir(), '.local', 'state', 'feishu-channel')
  const base = join(dir, cfg.appId)
  return {
    dir,
    seen: `${base}-seen.txt`,
    dms: `${base}-dm-chats.txt`,
    known: `${base}-groups.txt`,
    log: `${base}.log`,
    state: `${base}-state.json`,
    sock: `${base}.sock`,
    lock: `${base}.lock`,
    stopFlag: `${base}.stop`,
  }
}
