// 常驻进程、桥、hook、外层循环共用：读配置、算状态文件路径和本机通信端点
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'

/** 配置文件：环境变量 FEISHU_CHANNEL_CONFIG，其次命令行第一个参数（hook 命令这样传，不依赖 shell 的环境变量写法），最后是默认位置 */
export function configFile() {
  return process.env.FEISHU_CHANNEL_CONFIG ?? process.argv[2] ?? join(homedir(), '.config', 'feishu-channel', 'config.json')
}

export function readConfig() {
  const file = configFile()
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  if (!cfg.appId || !cfg.allow?.length) throw new Error(`${file} 缺 appId 或 allow`)
  return cfg
}

/**
 * 本机通信端点：Linux / macOS 是状态目录里的 Unix socket 文件；Windows 是命名管道，
 * 名字带状态目录的哈希 —— 管道是全机一个命名空间，同一个应用配了两个状态目录（或单测并行）时不能撞名。
 */
function endpoint(base, dir, appId, suffix, platform) {
  if (platform !== 'win32') return `${base}${suffix}.sock`
  const h = createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\feishu-channel-${appId}-${h}${suffix}`
}

export function paths(cfg, platform = process.platform) {
  const dir = cfg.stateDir ?? join(homedir(), '.local', 'state', 'feishu-channel')
  const base = join(dir, cfg.appId)
  return {
    dir,
    /** 端点是命名管道（不在文件系统里，不用也不能删） */
    pipe: platform === 'win32',
    seen: `${base}-seen.txt`,
    dms: `${base}-dm-chats.txt`,
    known: `${base}-groups.txt`,
    log: `${base}.log`,
    state: `${base}-state.json`,
    sock: endpoint(base, dir, cfg.appId, '', platform),
    /** 外层循环占着它，保证同一个状态目录只跑一份 */
    superSock: endpoint(base, dir, cfg.appId, '-supervise', platform),
    /** 常驻进程启动时写 { pid, start }，bin/restart.mjs 凭它认准要杀的那个进程 */
    pidFile: `${base}.pid`,
    /** 旧版外层循环（supervise.sh）flock 的锁文件；新版启动时看它还被占着就让位 */
    lock: `${base}.lock`,
    stopFlag: `${base}.stop`,
  }
}
