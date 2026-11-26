// 常驻进程、桥、hook、外层循环共用：读配置、算状态文件路径和本机通信端点
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platformOf } from './platform.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))

export const IS_WINDOWS = process.platform === 'win32'

/** 配置文件：环境变量 FEISHU_CHANNEL_CONFIG，其次命令行第一个参数（hook 命令这样传，不依赖 shell 的环境变量写法），最后是默认位置 */
export function configFile() {
  return process.env.FEISHU_CHANNEL_CONFIG ?? process.argv[2] ?? join(homedir(), '.config', 'feishu-channel', 'config.json')
}

/** 读配置并按平台查必填字段；platform 写了不认识的值时抛错 */
export function readConfig() {
  const file = configFile()
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  const p = platformOf(cfg)
  if (p.name === 'wecom') {
    if (!cfg.botId || !cfg.botSecretFile || !cfg.allow?.length) throw new Error(`${file} 缺 botId、botSecretFile 或 allow`)
  } else if (!cfg.appId || !cfg.allow?.length) throw new Error(`${file} 缺 appId 或 allow`)
  return cfg
}

/**
 * 本机通信端点：Linux / macOS 是状态目录里的 Unix socket 文件；Windows 是命名管道，
 * 名字带状态目录的哈希 —— 管道是全机一个命名空间，同一个应用配了两个状态目录（或单测并行）时不能撞名。
 */
function endpoint(base, dir, prefix, id, suffix, platform) {
  if (platform !== 'win32') return `${base}${suffix}.sock`
  const h = createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\${prefix}-${id}-${h}${suffix}`
}

/** 状态文件和本机端点。飞书按 appId 起名，企业微信按 wecom-<botId>，同一个状态目录里两个平台也不撞 */
export function paths(cfg, platform = process.platform) {
  const p = platformOf(cfg)
  const id = cfg[p.idField]
  const dir = cfg.stateDir ?? join(homedir(), '.local', 'state', 'feishu-channel')
  const base = join(dir, p.stateName(id))
  return {
    dir,
    /** 端点是命名管道（不在文件系统里，不用也不能删） */
    pipe: platform === 'win32',
    seen: `${base}-seen.txt`,
    dms: `${base}-dm-chats.txt`,
    /** 补过的会话（群和私信）；不在里面的是新会话，只补最近 24 小时 */
    known: `${base}-groups.txt`,
    log: `${base}.log`,
    state: `${base}-state.json`,
    sock: endpoint(base, dir, p.pipePrefix, id, '', platform),
    /** 外层循环占着它，保证同一个状态目录只跑一份 */
    superSock: endpoint(base, dir, p.pipePrefix, id, '-supervise', platform),
    /** 常驻进程启动时写 { pid, start }，bin/restart.mjs 凭它认准要杀的那个进程 */
    pidFile: `${base}.pid`,
    /** 旧版外层循环（supervise.sh）flock 的锁文件；新版启动时看它还被占着就让位 */
    lock: `${base}.lock`,
    stopFlag: `${base}.stop`,
    /** 长连接被另一处的新连接踢下线后留的标记：在时常驻进程不再连，等 bin/restart.mjs 删掉它 */
    kicked: `${base}.kicked`,
    /** 收到的图片、文件下载到这里 */
    media: `${base}-media`,
  }
}
