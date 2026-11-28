# feishu-channel-for-claude-code

Bring Feishu / Lark and WeCom (WeChat Work) chats into a running Claude Code session through Claude Code Channels: messages wake the session only when something arrives, follow-ups reach a busy session right away, chat members can stop the current turn remotely, and the session can schedule its own wake-ups. Feishu also gets read receipts, recall handling and a pinned status card.

One daemon serves both platforms. Everything that talks to Claude Code (delivery, tools, allowlist, rate limiting, busy/idle tracking, stop, schedules) is shared; each platform only supplies a small adapter. See [Adding a platform](#adding-a-platform).

## Read this first

- Channels is a Claude Code research preview. The protocol and flags may change.
- The session must be started with `--dangerously-load-development-channels`, which skips the official channel allowlist. Only use it if you trust this code.
- Anyone the channel admits can drive your Claude Code session, with the same power as typing in your terminal. Read [Security](#security).

## Layout

| Path | What it does |
| --- | --- |
| `src/daemon.mjs` | The long-running daemon. Only wires things together: reads the config, loads the adapter, builds a shared context and installs the modules below |
| `src/core/state.mjs` | Persistent state file and log |
| `src/core/admission.mjs` | Who gets in: `allow`, `allowChats`, `observe`, read markers, sender names |
| `src/core/delivery.mjs` | Queue, merging, delivery to the session, wake confirmation and retries |
| `src/core/busy.mjs` | Busy/idle from Claude Code hooks, interrupting the running tool |
| `src/core/control.mjs` | `reply` / `send_file`, the remote stop, being taken over by another connection |
| `src/core/outbox.mjs`, `src/core/ratelimit.mjs` | Every outgoing message goes through one rate-limited queue (per chat, per app, uploads) |
| `src/core/timers.mjs` | Scheduled wake-ups |
| `src/core/endpoint.mjs` | Local endpoint for the MCP bridge and hooks; tool calls |
| `src/core/message.mjs` | Message shape and time helpers shared by adapters |
| `src/extras/history.mjs` | Catch-up, unread folding, `read_unread` (platforms with message history) |
| `src/extras/recall.mjs` | Recall events and polling (platforms with recall) |
| `src/extras/status-ui.mjs` | Reactions and the pinned status card (platforms with cards / reactions) |
| `src/platform.mjs` | Platform identities and the adapter interface. No SDK imports, so the bridge and hooks can read it |
| `src/feishu.mjs`, `src/wecom.mjs` | Adapters built on the official SDKs |
| `src/tools.mjs` | MCP tool definitions and execution (loaded by the daemon) |
| `src/bridge.mjs` | MCP bridge over stdio; only forwards. Starts the supervisor if needed |
| `src/hook.mjs` | Claude Code hook: reports busy/idle and tool names, ends the turn when the stop flag is set |
| `src/supervise.mjs` | Supervisor: restarts the daemon, holds a local endpoint so one state directory runs one daemon |
| `bin/setup.mjs`, `bin/doctor.mjs`, `bin/restart.mjs`, `bin/install.mjs`, `bin/start.mjs` | Setup, self-check, daemon restart, the `team-claude` launcher |

The daemon keeps running after the session closes. Messages and schedules wait for the next session.

## Install

Node 20+. Linux and Windows (native Claude Code). The daemon, bridge and hooks talk over a Unix socket in the state directory on Linux, or a named pipe on Windows.

```bash
git clone <this repo> && cd feishu-channel-for-claude-code
npm ci --ignore-scripts
mkdir -p ~/.config/feishu-channel
cp config.example.json ~/.config/feishu-channel/config.json   # or config.example.wecom.json; then fill it in
node bin/setup.mjs                                            # writes mcp.json / settings.json and prints the launch command
```

Run the printed command, or install the `team-claude` launcher once (see [Launcher](#launcher)). Claude Code asks once to confirm the development channel. It does not work with `-p`.

The generated hook command is `node "<repo>/src/hook.mjs" "<config file>"`; the config path is an argument so it works from sh, cmd and PowerShell. `--mcp-config` and `--settings` are used instead of project settings so that sessions started without the channel flag do not load the bridge or hooks.

### Feishu / Lark

1. Create a custom app on the [Feishu Open Platform](https://open.feishu.cn/app), enable the bot, choose **long connection** for events, subscribe to `im.message.receive_v1` and `im.message.recalled_v1`, grant permissions to read and send messages, add reactions, pin messages and list chats, publish a version, and add the bot to your groups.
2. `node bin/doctor.mjs` lists missing permissions by feature. Missing core permissions exit with code 1 and the daemon will not start. Event subscriptions cannot be queried; check them by hand against the output.

### WeCom

Uses a WeCom **AI bot** in API mode with a long connection (`@wecom/aibot-node-sdk`, `wss://openws.work.weixin.qq.com`). No public URL or callback encryption is needed.

1. In the WeCom client: Workbench → AI Bot → Create → Manual, choose API mode and "long connection", set the visibility scope, save. The page shows the Bot ID and Secret.
2. Put the Secret in a file (`chmod 600`) and point `botSecretFile` at it.
3. Members find the bot under "AI Bots" in the address book and message it directly, or add it to an internal group and @ it.

Who can create bots: the super admin and authorized members. In companies with 1000+ members, long-connection bots must be enabled by an admin first. If the bot is not created by the super admin, sender ids in callbacks are encrypted userids (stable per person within the company; copy them from the log line `事件到达 … 发送者 …` if you need them).

### Windows

Same steps in PowerShell (`copy` instead of `cp`, `bin\setup.mjs`). Differences:

- The stop kills the foreground command with `taskkill /T /F` (there is no gentle signal). PowerShell tools run under a `cmd.exe` wrapper; the whole tree is killed from there. Finding the tool process uses `Get-CimInstance Win32_Process` (about 1 s), only on stop, recall interrupts and busy-timeout checks.
- `process` schedules identify processes by Windows creation time.
- The supervisor and daemon are detached windowless processes; closing the terminal does not stop them. To stop, end the two `node` processes whose command lines contain `supervise.mjs` and `daemon.mjs`.

## Launcher

`node bin/install.mjs` installs a `team-claude` command once per machine. In a working directory:

| Command | Does |
| --- | --- |
| `team-claude` | Continue the last session in this directory (`--continue`), or start a new one |
| `team-claude --new` | Always start a new session |
| `team-claude <args>` | Passed to `claude`; `--continue` is not added when you pass `-c`, `-r`, `--resume`, `--session-id` or `--fork-session` |

Config lookup order: `FEISHU_CHANNEL_CONFIG`, then `.feishu-channel/config.json` in the current directory or any parent, then the path given to `install --config`, then `~/.config/feishu-channel/config.json`. It prints which one it used. Missing or stale `mcp.json` / `settings.json` next to the config are regenerated. Then it starts `claude` with `--mcp-config`, `--settings` and `--dangerously-load-development-channels server:<feishu|wecom>` and returns its exit code.

Install location: `/usr/local/bin` (or `~/.local/bin`) on Linux / macOS; the npm global bin directory on Windows (`team-claude.cmd` and a Git Bash script). `--dir` picks a directory; an existing `team-claude` from elsewhere is not overwritten without `--force`. For several bots under one OS user, skip `--config` and keep each config in its working directory's `.feishu-channel/` (add it to `.gitignore`).

## Configuration

One JSON file per bot. `platform` selects the IM (`"feishu"` when omitted). An unknown value makes every entry point exit with an error.

### Common fields

| Field | Default | Meaning |
| --- | --- | --- |
| `allow` | | Sender ids that are trusted (see [Two kinds of senders](#two-kinds-of-senders)). Required on Feishu |
| `allowChats` | | Group ids where every sender is trusted |
| `observe` | off | Also deliver messages from untrusted senders, marked `trust="external"`. `true` = every chat the bot is in; `{ "chats": [...], "dms": true }` narrows it |
| `statusChat` | | Default chat for schedules (and the status card on Feishu). Without it, `schedule_add` needs a `chat_id` |
| `names` | | Sender id → display name |
| `withConfigs` | | Other configs to load into the same session, e.g. `["wecom.json"]`. See [One session, two channels](#one-session-two-channels) |
| `rateLimit` | platform defaults | Override send limits: `{ perMinute, perHour, appPerMinute, appPerHour, uploadPerMinute, uploadPerHour, maxWaitSec }`. See [Rate limits](#rate-limits) |
| `stateDir` | `~/.local/state/feishu-channel` | State directory |
| `timezone` | `Asia/Shanghai` | Time zone for schedules |
| `onceGraceMin` / `repeatGraceMin` | `10080` / `720` | How long a missed one-off / daily / weekly schedule is still delivered |
| `busyTimeoutSec` | `180` | Busy with no heartbeat for this long counts as idle |
| `wakeTimeoutSec` | `20` | Wait for the session to wake after a delivery; doubles on each retry, up to 5 minutes |
| `wakeRetryMax` | `10` | Stop retrying after this many deliveries without waking the session |
| `toolWaitMaxSec` | `86400` | A `PreToolUse` with no `PostToolUse` for this long no longer counts as busy |

### Feishu fields

| Field | Default | Meaning |
| --- | --- | --- |
| `appId` | | App id (required) |
| `appSecretFile` / `appSecret` / env `FEISHU_APP_SECRET` | | Secret, one of the three |
| `domain` | `feishu` | `lark` for the international version |
| `name` | `Claude Code` | Status card title |
| `unreadFoldAt` | `5` | Fold catch-up backlogs larger than this into one summary |
| `sweepSec` | `600` | Full catch-up interval, 0 to disable |
| `recallPollSec` / `recallWindowSec` / `recallHintSec` | `60` / `3600` / `30` | Recall polling fallback |
| `cardDebounceSec` | `5` | Status card update debounce |
| `expectedScopes` / `expectedScopesFile` | | Full permission list you expect; `doctor` reports differences |

### WeCom fields

| Field | Default | Meaning |
| --- | --- | --- |
| `botId` | | Bot ID (required) |
| `botSecretFile` | | File holding the Secret (required). Only read from here, never logged |
| `restrict` | `false` | WeCom admits every sender by default (see below). `true` applies `allow` / `allowChats` like Feishu |
| `wsUrl` | `wss://openws.work.weixin.qq.com` | Long connection URL (private deployments) |
| `reconnectBaseMs` | `1000` | First reconnect delay; exponential back-off up to 30 s |
| `heartbeatMs` | `30000` | Heartbeat interval; two missed acks count as a dead connection and trigger a reconnect |

**WeCom admits everyone by default.** WeCom AI bots can only be used by members of the company and cannot be added to external groups (groups with WeChat users), so every sender is already an internal member. Set `restrict: true` to fall back to `allow` / `allowChats`.

### One session, two channels

To feed one Claude Code session from both Feishu and WeCom, keep both configs in the same directory and list the second one in the main config:

```json
// .feishu-channel/config.json (Feishu)
{ "appId": "cli_xxx", "appSecretFile": "...", "allow": ["ou_xxx"], "withConfigs": ["wecom.json"] }
```

```json
// .feishu-channel/wecom.json (WeCom)
{ "platform": "wecom", "botId": "xxx", "botSecretFile": "..." }
```

`withConfigs` paths are relative to the main config's directory (absolute paths also work); a listed file that does not exist is an error. `team-claude` and `setup` then pass both MCP files (`mcp.json`, `wecom-mcp.json`), one merged `channels-settings.json` whose hooks report to both daemons, and `--dangerously-load-development-channels server:feishu server:wecom`. Each platform keeps its own daemon, state files and tools (`mcp__feishu__*`, `mcp__wecom__*`); a stop from either side ends the current turn. Without `withConfigs` nothing changes: only the main config is loaded.

A Feishu and a WeCom channel can run on the same machine and share a state directory: WeCom state files are named `wecom-<botId>…`, the MCP server is called `wecom` (tools `mcp__wecom__reply` etc., launch flag `server:wecom`), and `setup` writes `wecom-mcp.json` / `wecom-settings.json` when both configs live in the same directory.

## Tools

| Tool | Feishu | WeCom | |
| --- | --- | --- | --- |
| `reply` | ✓ | ✓ | Send text to a chat. Optional `reply_to` (a received `message_id`) quotes that message |
| `send_file` | ✓ | ✓ | Send a local file; images as images, other files as files |
| `schedule_add` / `schedule_list` / `schedule_remove` | ✓ | ✓ | Scheduled wake-ups |
| `read_unread` | ✓ | | Page through folded unread messages |

Tool definitions and execution live in the daemon. The bridge re-fetches the list on every reconnect and sends `notifications/tools/list_changed` when it changed, so `node bin/restart.mjs` is enough to ship tool changes to open Claude Code sessions. (Codex app-server ignores `list_changed`; new threads pick up the new list.) Server instructions are only sent at `initialize`; reconnect with `/mcp` to see changed instructions.

## Rate limits

Every outgoing message (replies, files, stop receipts, the status card) goes through one queue with three sliding-window buckets: per chat, per app, and uploads. When a bucket is full the message waits; if the wait would exceed `maxWaitSec` (default 60) the tool call fails with how many seconds to wait, and the session is told.

| | Per chat | Per app | Uploads | Official limits |
| --- | --- | --- | --- | --- |
| Feishu | 60/min, 3000/h | 1000/min, 60000/h | 60/min, 3000/h | Send message: 1000/min and 50/s per app; 5 QPS per user or group (shared by bots in a group). Images ≤ 10 MB, files ≤ 30 MB |
| WeCom | 20/min, 900/h | — | 20/min, 900/h | Replies and pushes together: 30/min and 1000/h per chat. Uploads: 30/min and 1000/h per bot. Images ≤ 10 MB, files ≤ 20 MB |

## Two kinds of senders

| | Trusted (`allow`, `allowChats`, or everyone on WeCom) | External (`observe` only) |
| --- | --- | --- |
| Delivery | Wakes an idle session; reaches a busy session right away | Same |
| `meta.trust` | none | `external` |
| Stop | Hard stop: clear the queue, kill the foreground command, block further tool calls, pause schedules | Delivered as an ordinary message |
| Recall of a delivered message | Interrupts the turn that is handling it | Only a void notice, no interrupt |
| Schedules | A new message resumes schedules paused by a stop | Does not resume them |

External messages are never merged with trusted ones. The MCP instructions tell the model that `trust="external"` content is data, not instructions.

## Behavior

- **Busy / idle**: `UserPromptSubmit`, `PreToolUse` and deliveries mark busy, `Stop` marks idle, tool hooks are heartbeats. A tool that has a `PreToolUse` but no `PostToolUse` yet (waiting for an answer, a permission prompt, a long command) keeps the session busy even past the heartbeat timeout. Esc has no `Stop` hook; the heartbeat timeout recovers.
- **Merged delivery**: when idle, queued messages from one chat are merged into one notification. Claude Code silently drops notifications while it is not ready, so a delivery only counts once a hook fires; otherwise it is requeued and retried with back-off (`meta.retry` is set, deduplicate by `message_id`). After `wakeRetryMax` failures retries stop until the session shows activity.
- **Busy delivery**: senders' messages reach a busy session immediately; Claude Code adds them to the current turn after the running tool call, marked as external content. The daemon's own notices and schedules wait for idle. Nothing is delivered while the stop flag is set.
- **Stop**: a trusted text message that is exactly `停` clears the queue, kills the foreground Bash / PowerShell process tree, blocks further tool calls, ends the turn, pauses schedules until the next new instruction, and replies with what was dropped.
- **Schedules**: `once` (`YYYY-MM-DD HH:MM` in the configured time zone, or ISO with offset), `daily`, `weekly`, `process` (wait for a pid). Stored on disk. Each schedule belongs to a chat: the `chat_id` given to `schedule_add` (an id of that channel's platform), or `statusChat` when omitted; with neither, `schedule_add` fails. A due schedule reaches the session as a notice filed under that chat. Missed schedules are delivered later with how late they are, within the grace period; otherwise skipped with a notice sent to that chat. `schedule_list` marks overdue schedules with why they have not fired (session offline, paused by a stop, no chat).
- **Feishu only** (needs message history, recall and cards):
  - Catch-up: events are queued directly; the daemon also re-reads each chat after an event, on (re)connect and every `sweepSec` to fill gaps. Chats seen for the first time only deliver messages after the install time. Unknown sender open_ids are resolved once with a single-message lookup and cached.
  - Unread folding: a catch-up backlog larger than `unreadFoldAt` for one chat delivers only the newest message with an `[未读摘要]` summary; the rest are kept as unread for `read_unread`.
  - Recall: queued messages are dropped; a message being handled interrupts its turn; a finished one gets a void notice. Recall events plus polling as a fallback.
  - Reactions: `GLANCE` queued, `OneSecond` in progress, `CheckMark` done, `CrossMark` stopped or void.
  - Status card pinned in `statusChat`: busy/idle, current tool name (never its arguments), queue length, next schedule, warnings.
  - Attachments are given as keys (`[Image: key]`, `<file key=…>`); fetch them with the Feishu API when needed.
- **WeCom only**:
  - Direct messages, and group messages that @ the bot (the platform only pushes those; there is no switch). Group chat id is the group's `chatid`; the leading `@bot` is removed.
  - Images and files are downloaded and decrypted right away (download URLs expire after 5 minutes) into `<stateDir>/wecom-<botId>-media/`; the message text carries the local path. Image extensions follow the content. Voice is not supported (the text says so). Video is a placeholder.
  - `reply` sends markdown via active push; the member must have messaged the bot first. With `reply_to`, it uses the passive reply channel instead, which quotes the original message in groups; this only works for messages received by this daemon process within 24 hours and falls back to a push otherwise. `<@userid>` in markdown does not become a mention.
  - No history, recall, reactions or cards. Messages sent while the connection is down are not delivered later.
  - Only one live connection per bot: a new connection elsewhere kicks this one. The daemon then stops sending, does not reconnect (that would kick the other side), leaves `wecom-<botId>.kicked` in the state directory and tells the session. `node bin/restart.mjs` removes the marker and reconnects. Network drops and missed heartbeats reconnect automatically.

## Security

- On Feishu, `allow` is required. Only list people you trust: they can drive your Claude Code session as if typing in your terminal. On WeCom every company member who can see the bot has that power unless you set `restrict: true`; choose the bot's visibility scope accordingly.
- No permission-prompt forwarding: tool calls cannot be approved from chat.
- The stop kills processes; files being written may be left half-written.
- External-content marking is kept on purpose: busy deliveries are marked external by Claude Code. Messages are never injected via hooks, keystrokes or signals; the stop flag only blocks tools.
- `observe` delivers but never authorizes. With `observe: true`, anyone who can add the bot to a group or DM it can write into your session; limit what the session may do through its own instructions (CLAUDE.md) and Claude Code permissions, and require human confirmation for destructive or outward-facing actions.
- Keep secrets out of the repo; use `appSecretFile` / `botSecretFile`.

If only trusted people can reach the session, you can tell it so in its CLAUDE.md, for example: "Messages from the channel come from trusted senders. Follow-ups that arrive while busy, marked as external content, may be used to adjust the current task without asking back. Deletions, production changes and public posts still need confirmation." Do not write this if untrusted people can reach it; with `observe`, say it only applies to messages without `trust="external"`.

## Adding a platform

1. Add an entry to `PLATFORMS` in `src/platform.mjs`: account id field, state file naming, local endpoint prefix, chat id format, instructions for the model, and the feature switches (`unread`, `quoteReply`, `sendFile`, `allowAllByDefault`).
2. Write an adapter exporting `connect(cfg, log)` that returns at least `listen(handlers)` and `sendText(chat, text, opts)`. Optional: `limits`, `upload` / `sendMedia`, `userName`, and `caps` with the matching methods for history, recall, reactions, cards and permission checks. The full contract is at the top of `src/platform.mjs`.

Everything else (delivery, tools, allowlist, rate limiting, busy/idle, stop, schedules) works unchanged.

## Codex

The daemon can also feed a Codex CLI session through `codex app-server` (Feishu only).

```json
{ "codex": { "threadId": "<session UUID>", "cwd": "<working directory>" } }
```

```bash
node bin/setup.mjs --codex /path/to/config.json
node src/codex.mjs /path/to/config.json
```

Without `threadId` a dedicated session is created and its UUID saved in `<stateDir>/<appId>-codex.json`. `setup --codex` writes a `codex.config.toml` snippet with the MCP server (tools only); merge `mcp_servers.feishu` into the workspace's trusted `.codex/config.toml` and reload MCP. By default it connects to the local shared daemon through `codex app-server proxy`; set `codex.args` to `["app-server", "--listen", "stdio://"]` for a dedicated process.

- Busy/idle comes from app-server turn/item events (no Claude Code hooks). Idle wake uses `turn/start`, busy follow-ups `turn/steer`, stop and recall `turn/interrupt`. An ack is sent only after the RPC succeeds.
- Stop also cleans up the current turn's command processes, only when the process can be matched to this thread unambiguously; otherwise it only interrupts the turn. There is no synchronous pre-tool gate.
- If Codex rejects a steer during compaction, the receiver waits for the turn to finish and retries; delivery markers in the history prevent duplicates. Ambiguous RPC failures keep the queue and exit instead of risking duplicate execution.
- Supported on Linux and Windows; macOS lacks the `/proc` process ownership data this needs.

## Restarting the daemon

```bash
node bin/restart.mjs   # same config lookup as other entry points
```

The daemon writes its pid and start time to `<stateDir>/<id>.pid`; `restart.mjs` only kills a process matching both, then waits for the supervisor to start a new one (exit 0), reports nothing running (1), or a kill without a replacement within 15 s (2). In auto mode you can allow `Bash(node <repo>/bin/restart.mjs*)` so the session can restart it itself.

## Troubleshooting

The log is `<stateDir>/<id>.log` (UTC, milliseconds). A message goes through `事件到达` (event arrived), `get 确认` (sender lookup, Feishu), `拉取开始/结束` (catch-up), `入队` (queued), `已送出` (delivered) and `已唤醒` (session woke). "Creation →" latencies are measured against the server's timestamps; check your clock offset first (virtual machines are often seconds off).

## Tests

```bash
npm test
```

No credentials needed: `test/fake-feishu.mjs` replaces Feishu; `test/fake-wecom-server.mjs` is a local WebSocket server speaking the WeCom AI bot frame format (auth, heartbeat, push acks, passive replies, media upload, kicks, drops, missed heartbeats) plus an HTTP server for encrypted attachments, so tests run the real SDK and the real daemon. The test that kills a real bash child only runs on Linux / macOS; Windows process handling is covered with simulated PowerShell output.

## Known limitations

- Only foreground Bash / PowerShell commands are killed on stop; other tools are blocked at their next `PreToolUse`.
- After Esc or a crash, in-progress reactions stay; Esc counts as idle only after `busyTimeoutSec`.
- A model thinking longer than `busyTimeoutSec` without tool calls is treated as idle.
- The first message after reopening a session takes about `wakeTimeoutSec` to arrive.
- One daemon and one session per bot; one `statusChat`.
- Feishu: event subscriptions cannot be checked automatically; without recall events, recalls are only found by polling within `recallWindowSec`.
- WeCom: no catch-up, so messages sent while disconnected are lost; voice is not supported.
