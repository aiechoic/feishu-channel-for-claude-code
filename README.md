# feishu-channel-for-claude-code

Bring Feishu / Lark chats into a running Claude Code session through Claude Code Channels, with busy-aware delivery, a remote stop, recall handling, status in chat, and scheduled wake-ups.

把飞书的群和私信送进运行中的 Claude Code 会话：有消息才唤醒，忙时排队合并，能远程喊停，飞书里看得到状态，还能定时唤醒。

## 风险：先读这一段

- 依赖 Claude Code 的研究预览功能 Channels，协议和参数都可能变动。
- 启动要带 `--dangerously-load-development-channels`，这个参数跳过了官方 channel 名单，只在你信任本项目代码时使用。
- 飞书用户能往你的会话里发指令，白名单就是这道门，见「安全」。

## 组成

| 文件 | 作用 |
| --- | --- |
| `src/daemon.mjs` | 常驻进程：长连接、已读记录、队列、忙闲、停、撤回、定时、表情、状态卡片 |
| `src/supervise.sh` | 外层循环：常驻进程退出后拉起，文件锁保证单份 |
| `src/bridge.mjs` | MCP 桥（stdio）：只转发，启动时确保外层循环在跑 |
| `src/hook.mjs` | Claude Code hook：上报忙闲和工具名，看到停止标记时结束这一轮 |
| `src/feishu.mjs` | 飞书适配器，基于官方 Node SDK |

会话关闭后常驻进程继续运行，消息和定时都留着，下次会话连上再送。

## 安装

需要 Node 20+、Linux（用到 `/proc` 和 `flock`）。

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

## 行为

- **忙闲**：`UserPromptSubmit` 和送出标忙，`Stop` 标闲，工具 hook 写心跳。按 Esc 没有 `Stop`，靠心跳超时恢复。桥断开算离线。
- **合并送达**：闲时把同一会话的排队消息合并成一条。送出后等到 hook 才算送达，因为 Claude Code 未就绪时会静默丢通知；等不到就退回队列退避重发，重发的 `meta.retry` 有值，按 `message_id` 去重。
- **停**：白名单发送者的文本消息整条是「停」才触发。清空队列，杀当前前台 Bash 工具的进程树（后台任务和 Claude Code 本身不动），之后的工具调用被拒绝，这一轮结束，回群报丢了几条。
- **撤回**：排队中的直接不送；已送达的自动停，再补发一条作废说明。
- **表情**：`GLANCE` 排队，`OneSecond` 处理中，`CheckMark` 完成，`CrossMark` 已停或作废。
- **自检**：常驻进程启动时按功能检查权限。核心权限（收消息、拉历史、发消息、拉群列表）缺失就退出，外层循环 5 分钟后再试；其余只记日志并在卡片上提示。权限查询本身失败不挡启动。轮询发现撤回而同一条没收到事件时，日志和卡片提示「撤回事件可能没订阅」，每次启动只提示一次。
- **状态卡片**：置顶在 `statusChat`，内容变化才更新：忙闲、几点起、当前工具名、排队数、下一个定时。只写工具名，不写命令内容。
- **定时**：会话用 `schedule_add`、`schedule_list`、`schedule_remove` 管理，落盘，会话、常驻进程、容器重开都不丢。`once` 一次性（`YYYY-MM-DD HH:MM` 按配置时区，或带时区的 ISO 时间），`daily` 每天，`weekly` 每周，`process` 等某个 pid 结束。`text` 写清做什么、看哪个文件。到点进同一条队列，和消息合并时标清哪条是定时。不在线时错过的，上线后补发并标明晚了多久；过了宽限期只在群里回报跳过。「停」清掉已触发的定时并暂停其余定时，下一条新指令恢复，恢复后按错过处理。

## 安全

- `allow` 必须配，只放你信任的人。名单里的人能驱动你的 Claude Code，权限等同于你在终端打字。
- 不做权限审批转发：飞书里不能批工具调用。
- 「停」会杀进程，正在写的文件可能留下半成品。
- 不绕开 Claude Code 的外部内容标记：忙时到达的内容会被标成外部内容，这个标记有意保留。本项目不用 hook 把消息注入上下文，也不模拟按键或发 SIGINT；停止标记只用来拦工具。
- secret 不要提交，放在 `appSecretFile` 指向的文件里。

## 已知限制

- 只杀前台 Bash；其他工具靠下一次 `PreToolUse` 拦。
- 按 Esc 或崩溃后，处理中的表情不会变成完成；Esc 后默认约 3 分钟才判闲。
- 模型思考超过 `busyTimeoutSec` 且没有工具调用时，会被判闲并提前送出。
- 重开会话后第一条消息约 `wakeTimeoutSec` 秒才到。
- 事件订阅无法自动检查，开放平台没有查询接口。
- 撤回事件未订阅时只靠轮询，有延迟，且 `recallWindowSec` 外的撤回不处理。
- 只有一个 `statusChat`，定时消息都发到这里。
- 同一应用只跑一个常驻进程、一个会话。
- 长连接重连由官方 SDK 负责；连接悄悄失效时靠 `sweepSec` 的定时全量补漏兜底，最长延迟这么久。

## 测试

```bash
npm test
```

用 `test/fake-feishu.mjs` 代替飞书，不需要凭据。

测过的 Claude Code 版本：2.1.316（真实飞书 + 真实会话）。

真实环境验证过：闲时唤醒、忙时合并、停、撤回事件、定时（一次性、等进程、暂停后补发、离线补发）、常驻进程被杀后恢复。没有验证过：真实断网下的长连接重连（由官方 SDK 负责）、`daily` 和 `weekly` 到点触发（只有单测）。
