# feishu-channel-for-claude-code

Bring Feishu / Lark chats into a running Claude Code session through Claude Code Channels, with busy-aware delivery, a remote stop, recall handling, status in chat, and scheduled wake-ups.

把飞书的群和私信送进运行中的 Claude Code 会话：有消息才唤醒，忙时补充立刻送进这一轮，能远程喊停，飞书里看得到状态，还能定时唤醒。

## 风险：先读这一段

- 依赖 Claude Code 的研究预览功能 Channels，协议和参数都可能变动。
- 启动要带 `--dangerously-load-development-channels`，这个参数跳过了官方 channel 名单，只在你信任本项目代码时使用。
- 飞书用户能往你的会话里发指令，白名单就是这道门，见「安全」。

## 组成

| 文件 | 作用 |
| --- | --- |
| `src/daemon.mjs` | 常驻进程：长连接、已读记录、队列、忙闲、停、撤回、定时、表情、状态卡片 |
| `src/supervise.mjs` | 外层循环：常驻进程退出后拉起；占住一个本机端点保证同一状态目录只跑一份 |
| `src/bridge.mjs` | MCP 桥（stdio）：只转发，启动时确保外层循环在跑 |
| `src/hook.mjs` | Claude Code hook：上报忙闲和工具名，看到停止标记时结束这一轮 |
| `src/feishu.mjs` | 飞书适配器，基于官方 Node SDK |
| `bin/restart.mjs` | 重启常驻进程：凭 pid 文件认准再杀，等外层循环拉起新的 |
| `src/proc.mjs` | 进程表：查子进程、杀进程树、取启动时刻；Linux 读 `/proc`，Windows 用 PowerShell 和 `taskkill` |

会话关闭后常驻进程继续运行，消息和定时都留着，下次会话连上再送。

## 安装

需要 Node 20+。支持 Linux 和 Windows（原生 Claude Code）。常驻进程、桥、hook 之间走本机端点：Linux 是状态目录里的 Unix socket，Windows 是命名管道 `\\.\pipe\feishu-channel-<appId>-<状态目录哈希>`。

1. 在[飞书开放平台](https://open.feishu.cn/app)建自建应用，开机器人能力，事件订阅选**长连接**，订阅 `im.message.receive_v1`、`im.message.recalled_v1`，开通读写消息、表情回复、置顶、读群列表的权限，发布版本，把机器人拉进群。
2. 安装：

   ```bash
   git clone <本仓库> && cd feishu-channel-for-claude-code
   npm ci --ignore-scripts
   mkdir -p ~/.config/feishu-channel
   cp config.example.json ~/.config/feishu-channel/config.json   # 然后填写
   node bin/setup.mjs                                            # 生成配置并打印启动命令
   ```

3. 自检：`node bin/doctor.mjs`，按功能列出缺的权限和影响。核心权限缺失时退出码 1，常驻进程也不会启动。事件订阅没有查询接口，要照输出手动核对。
4. 运行 `setup.mjs` 打印的命令。启动时要确认一次开发 channel。`-p` 模式下不生效。

生成的 hook 命令是 `node "<仓库>/src/hook.mjs" "<配置文件>"`，配置文件当参数传，sh、cmd、PowerShell 都能跑。

### Windows

要 Node 20+（`node` 在 PATH 里）。Claude Code 在 Windows 上跑命令用 PowerShell 工具（`powershell.exe` / `pwsh.exe`）或 Bash 工具（Git Bash 的 `bash.exe`），两种都认。PowerShell 里：

```powershell
git clone <本仓库>; cd feishu-channel-for-claude-code
npm ci --ignore-scripts
mkdir $HOME\.config\feishu-channel -Force
copy config.example.json $HOME\.config\feishu-channel\config.json   # 然后填写；stateDir 不填就是 %USERPROFILE%\.local\state\feishu-channel
node bin\setup.mjs
```

其余同上。和 Linux 的差别：

- 「停」杀前台工具用 `taskkill /T /F`（Windows 没有让工具收尾的温和信号）。PowerShell 工具的进程外面隔一层 `cmd.exe`（命令行里带 `powershell.exe` / `pwsh.exe`），从这层 `cmd.exe` 起杀整棵树；找工具进程用 PowerShell 的 `Get-CimInstance Win32_Process`，每次约 1 秒，只在「停」、撤回打断、忙时心跳超时时查。
- `process` 定时按 Windows 的进程创建时间认进程。
- 外层循环和常驻进程是无窗口的分离进程，关掉终端不影响；要停就在任务管理器里结束 `node`（命令行含 `supervise.mjs` 和 `daemon.mjs` 的两个）。

用 `--mcp-config` 和 `--settings` 而不是项目配置：没带 channel 参数的会话不该接这个桥，也不该跑这些 hook。

## 配置

`~/.config/feishu-channel/config.json`，环境变量 `FEISHU_CHANNEL_CONFIG` 可换路径。

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appId` | 是 | | 应用 id |
| `appSecretFile` | 三选一 | | 存 secret 的文件，建议 `chmod 600` |
| `appSecret` / 环境变量 `FEISHU_APP_SECRET` | 三选一 | | secret |
| `allow` | 是 | | 放行的发送者 id：用户 open_id（每个应用看到的不同）、机器人 app_id |
| `statusChat` | 否 | | 状态卡片和定时消息所在的群；不配就没有卡片和定时 |
| `name` | 否 | `Claude Code` | 卡片标题 |
| `names` | 否 | | 发送者 id → 显示名。接口常不返回姓名，不配时 `sender_name` 可能为空 |
| `domain` | 否 | `feishu` | `lark` 用于国际版 |
| `stateDir` | 否 | `~/.local/state/feishu-channel` | 状态目录 |
| `timezone` | 否 | `Asia/Shanghai` | 定时所用时区 |
| `onceGraceMin` | 否 | `10080` | 一次性定时错过后还补发的分钟数，可按条覆盖 |
| `repeatGraceMin` | 否 | `720` | 每天、每周定时错过后还补发的分钟数，可按条覆盖 |
| `busyTimeoutSec` | 否 | `180` | 忙但没有心跳多久后按闲处理 |
| `wakeTimeoutSec` | 否 | `20` | 送出后等会话唤醒的时间 |
| `recallPollSec` | 否 | `60` | 撤回轮询兜底间隔，0 关闭 |
| `recallWindowSec` | 否 | `3600` | 轮询覆盖多久内送达的消息 |
| `sweepSec` | 否 | `600` | 定时全量补漏间隔，0 关闭 |
| `recallHintSec` | 否 | `30` | 轮询发现撤回后，等多久没收到事件就提示可能没订阅 |
| `expectedScopes` / `expectedScopesFile` | 否 | | 部署方应有的全部权限（数组，或存数组的 JSON 文件）。`doctor` 报多了、少了哪些，用来发现后台配置被改动 |

### 机器人发送者走快路

事件里的发送者只有 open_id，机器人也一样。没见过的 open_id 会 get 一次单条，确认它对应的发送者 id（机器人是 `cli_` 开头的 app id），之后记在状态文件里，同一发送者再来消息就不再 get：在白名单里的直接入队，不在的直接丢弃。最多记 1000 个发送者。

所以 `allow` 里写机器人的 `cli_` app id 就够了，只有它的第一条消息多花一次 get（约 1 秒）。连这一次也想省，就把它的 open_id 也写进 `allow`，`names` 里同样加一条。同一个机器人在不同应用看到的 open_id 不同，每个应用要各自查：让那个机器人发一条消息，在日志里找 `事件到达 … 发送者 ou_…`。

## 行为

- **忙闲**：`UserPromptSubmit` 和送出标忙，`Stop` 标闲，工具 hook 写心跳。按 Esc 没有 `Stop`，靠心跳超时恢复。桥断开算离线。
- **合并送达**：闲时把同一会话的排队消息合并成一条。送出后等到 hook 才算送达，因为 Claude Code 未就绪时会静默丢通知；等不到就退回队列退避重发，重发的 `meta.retry` 有值，按 `message_id` 去重。
- **忙时送达**：会话忙时，白名单发送者的消息也立刻送出，不等这一轮结束；Claude Code 在当前工具调用结束时把它带进这一轮（会触发一次 UserPromptSubmit），并标成外部内容，所以最长要等当前这个工具跑完。上一条还没被桥确认时到的消息，确认后同一会话合并送出。常驻进程自己的说明（撤回作废）和定时仍等闲时送。停止标记在时（「停」或撤回打断这一轮期间）也等闲，不往要结束的这一轮里送；「停」之前已送出、还没进会话的补充随后照样进会话，但不解除停止标记。忙时送达的消息同样算处理中：撤回会打断这一轮，「停」把它标成已停。
- **停**：白名单发送者的文本消息整条是「停」才触发。清空队列，杀当前前台命令工具（Bash 或 PowerShell）的进程树（后台任务和 Claude Code 本身不动），之后的工具调用被拒绝，这一轮结束，回群报丢了几条。
- **收消息**：事件带的内容直接入队，不拉历史。发送者的 open_id 在 `allow` 里、或之前 get 认过时走这条路；没见过或缺字段时 get 单条，按它返回的发送者（机器人是 `cli_` 开头的 app id）再判一次。get 失败或入队失败时立即补拉这个会话，列表暂时没有就只对这个会话退避重试，不影响其他会话的补漏。入队后再在后台拉一次这个会话，补上没来事件的消息，不影响送达速度。全量补漏用来补断线期间的消息。
- **首次运行**：状态目录里还没有已读记录时，第一轮全量补漏把各会话现有的消息记为已读、不送，日志按会话写一行跳过了哪些；这一轮补完之后到的消息照常送。之后新进的群只补最近 24 小时，同样写日志。
- **撤回**：排队中的从队列撤下，回执「已从队列撤下」。正在处理的打断这一轮（拦工具调用、杀前台工具），回执写明消息 id，再补发作废说明；队列不清。已处理完的回执「已作废」，补发作废说明。撤回都不暂停定时，只有「停」暂停。
- **表情**：`GLANCE` 排队，`OneSecond` 处理中，`CheckMark` 完成，`CrossMark` 已停或作废。
- **自检**：常驻进程启动时按功能检查权限。核心权限（收消息、拉历史、发消息、拉群列表）缺失就退出，外层循环 5 分钟后再试；其余只记日志并在卡片上提示。权限查询本身失败不挡启动。轮询发现撤回而同一条没收到事件时，日志和卡片提示「撤回事件可能没订阅」，每次启动只提示一次。
- **状态卡片**：置顶在 `statusChat`，内容变化才更新：忙闲、几点起、当前工具名、排队数、下一个定时。只写工具名，不写命令内容。
- **定时**：会话用 `schedule_add`、`schedule_list`、`schedule_remove` 管理，落盘，会话、常驻进程、容器重开都不丢。`once` 一次性（`YYYY-MM-DD HH:MM` 按配置时区，或带时区的 ISO 时间），`daily` 每天，`weekly` 每周，`process` 等某个 pid 结束。`text` 写清做什么、看哪个文件。到点进同一条队列，和消息合并时标清哪条是定时。不在线时错过的，上线后补发并标明晚了多久；过了宽限期只在群里回报跳过。「停」清掉已触发的定时并暂停其余定时，下一条新指令恢复，恢复后按错过处理。

## 安全

- `allow` 必须配，只放你信任的人。名单里的人能驱动你的 Claude Code，权限等同于你在终端打字。
- 不做权限审批转发：飞书里不能批工具调用。
- 「停」会杀进程，正在写的文件可能留下半成品。
- 不绕开 Claude Code 的外部内容标记：忙时到达的内容会被标成外部内容，这个标记有意保留。本项目不用 hook 把消息注入上下文，也不模拟按键或发 SIGINT；停止标记只用来拦工具。
- 忙时送达只是不再等这一轮结束，放行判断不变：送进会话的消息都过了白名单。

### 给部署方：写进会话的说明

外部内容标记会让模型对忙时到达的补充更谨慎，常见做法是先回去确认，补充就失去了意义。白名单只放用户和主控时，可以在会话的 CLAUDE.md 里写明来源和边界，例如：

> channel 送来的消息，发送人已经按白名单核过，只可能是用户或主程。忙时到达、带外部内容标记的补充，可以直接用来调整手上的任务，不用先回群确认。删除、动线上、对外发布、跑 `--yes` 这类动作照样先确认。

白名单里有不完全可信的人时不要这样写。
- secret 不要提交，放在 `appSecretFile` 指向的文件里。

## 已知限制

- 只杀前台的 Bash / PowerShell 命令；其他工具靠下一次 `PreToolUse` 拦。
- 按 Esc 或崩溃后，处理中的表情不会变成完成；Esc 后默认约 3 分钟才判闲。
- 模型思考超过 `busyTimeoutSec` 且没有工具调用时，会被判闲并提前送出。
- 重开会话后第一条消息约 `wakeTimeoutSec` 秒才到。
- 事件订阅无法自动检查，开放平台没有查询接口。
- 撤回事件未订阅时只靠轮询，有延迟，且 `recallWindowSec` 外的撤回不处理。
- 只有一个 `statusChat`，定时消息都发到这里。
- 同一应用只跑一个常驻进程、一个会话。
- 长连接重连由官方 SDK 负责；连接悄悄失效时靠 `sweepSec` 的定时全量补漏兜底，最长延迟这么久。

## 重启常驻进程

升级代码或改了配置后，重启常驻进程（不动外层循环，它 2 秒后把常驻进程拉起来）：

```bash
node bin/restart.mjs            # 配置文件取法同其他入口：环境变量 FEISHU_CHANNEL_CONFIG、第一个参数、默认位置
```

常驻进程启动时把自己的 pid 和启动时刻写进 `<stateDir>/<appId>.pid`。`restart.mjs` 两样都和进程表对得上才杀（防 pid 被复用后杀错），杀完等新的常驻进程写进新 pid，打印新旧 pid；15 秒等不到就报错。退出码：0 重启成功；1 没在跑，什么都没杀；2 杀了但等不到新的（多半是外层循环不在，重开一次会话会把它拉起）。Linux 发 SIGTERM，Windows 用 `taskkill /F`，只杀这一个进程。

自动模式下，在 `.claude/settings.json` 的 `permissions.allow` 里加 `"Bash(node <仓库路径>/bin/restart.mjs*)"`，会话就能自己重启，不用请人手动杀进程。

## 排查

收消息慢时先看日志（`<stateDir>/<appId>.log`，时间是 UTC，带毫秒）。一条消息依次有：`事件到达`（创建→到达、事件时间→到达）、走 get 时的 `get 确认`、补漏时的 `拉取开始` / `拉取结束`、`入队`（创建→入队）、`已送出`（创建→送出）、`已唤醒`。

**日志里的「创建→」都减去了飞书服务端时间，先量本机时钟偏差再读。** 虚拟机和容器的时钟可能差好几秒，这部分不是真实延迟。「拉取」「get 确认」「送出→唤醒」是本机计时，不受影响。

量法：在同一条 HTTPS 长连接上连续请求飞书，取响应头 `Date` 的时间戳 `s`（精确到秒），记下请求前后的本机时间 `t0`、`t1`。本机领先量落在 `max(t0 - s - 1)` 到 `min(t1 - s)` 之间，采样 10 次以上、持续几秒就能缩到 1 秒内：

```python
import email.utils, http.client, time
c = http.client.HTTPSConnection('open.feishu.cn', timeout=5)
lo, hi, end = -1e9, 1e9, time.time() + 6
while time.time() < end:
    t0 = time.time(); c.request('HEAD', '/'); r = c.getresponse(); r.read(); t1 = time.time()
    s = email.utils.parsedate_to_datetime(r.headers['Date']).timestamp()
    lo, hi = max(lo, t0 - s - 1), min(hi, t1 - s)
print(f'本机领先 {lo:.3f}..{hi:.3f} 秒')
```

对照：本机记下发一条消息前后的时间，减去返回的 `create_time`，结果应落在同一范围。

## 测试

```bash
npm test
```

用 `test/fake-feishu.mjs` 代替飞书，不需要凭据。GitHub Actions 在 ubuntu 和 windows 上各跑一遍。「停」杀真实 bash 子进程那条只在 Linux / macOS 跑；Windows 的查表和杀树由 `test/proc.test.mjs` 用模拟的 PowerShell 输出覆盖。

测过的 Claude Code 版本：2.1.316（真实飞书 + 真实会话）。

真实环境（Linux）验证过：闲时唤醒、忙时送达、忙时合并、停、撤回事件、定时（一次性、等进程、暂停后补发、离线补发）、常驻进程被杀后恢复。没有验证过：真实断网下的长连接重连（由官方 SDK 负责）、`daily` 和 `weekly` 到点触发（只有单测）、Windows 上的真实会话。
