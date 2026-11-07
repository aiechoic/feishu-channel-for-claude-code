// 假飞书：消息来自 $FAKE/messages.json；$FAKE/fire 触发不带内容的事件，$FAKE/event 触发带内容的事件（{ chat, message }），$FAKE/get-fail 让 get 失败，$FAKE/recall 触发撤回事件，$FAKE/names.json 是 userName 查得到的名字；发出去的动作记到文件
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'

const dir = process.env.FAKE
const all = () => JSON.parse(readFileSync(`${dir}/messages.json`, 'utf8'))

const brief = content => `${content.match(/忙|闲|离线/)?.[0] ?? ''} ${content.match(/下一个定时[^"\\]*/)?.[0] ?? ''} ${content.match(/会话一直没唤醒[^"\\]*/)?.[0] ?? ''}`

export function connect() {
  return {
    listChats: async () => ['oc_group'],
    async grantedScopes() {
      if (existsSync(`${dir}/scopes-fail`)) throw new Error('无权查询')
      return existsSync(`${dir}/scopes.json`) ? JSON.parse(readFileSync(`${dir}/scopes.json`, 'utf8')) : ['im:message', 'im:chat', 'im:message.group_msg', 'im:message.p2p_msg:readonly']
    },
    async listMessages(chat) {
      if (existsSync(`${dir}/list-fail`)) {
        rmSync(`${dir}/list-fail`)
        throw new Error('EOF')
      }
      return { messages: all().filter(m => m.chat_id === chat).reverse(), hasMore: false }
    },
    async getMessage(id) {
      appendFileSync(`${dir}/get.log`, `${id}\n`)
      if (existsSync(`${dir}/get-fail`)) throw new Error('EOF')
      return all().find(m => m.message_id === id) ?? null
    },
    async userName(openId) {
      appendFileSync(`${dir}/names.log`, `${openId}\n`)
      const names = existsSync(`${dir}/names.json`) ? JSON.parse(readFileSync(`${dir}/names.json`, 'utf8')) : {}
      if (!(openId in names)) throw new Error('无权查通讯录')
      return names[openId]
    },
    async sendText(chat, text) {
      appendFileSync(`${dir}/sent.txt`, `${chat}|${text}\n`)
      return 'om_sent'
    },
    async addReaction(id, emoji) {
      appendFileSync(`${dir}/reactions.txt`, `${id} ${emoji}\n`)
      return 'r1'
    },
    removeReaction: async (id) => appendFileSync(`${dir}/reactions.txt`, `${id} delete\n`),
    async sendCard(chat, content) {
      appendFileSync(`${dir}/card.txt`, `send ${brief(content)}\n`)
      return 'om_card'
    },
    patchCard: async (id, content) => appendFileSync(`${dir}/card.txt`, `patch ${brief(content)}\n`),
    pin: async () => appendFileSync(`${dir}/card.txt`, 'pin\n'),
    listen(h) {
      appendFileSync(`${dir}/consume.log`, 'start\n')
      h.onConnected()
      setInterval(() => {
        if (existsSync(`${dir}/fire`)) {
          const chat = readFileSync(`${dir}/fire`, 'utf8').trim()
          rmSync(`${dir}/fire`)
          h.onMessage({ chat, chatType: 'group' })
        }
        if (existsSync(`${dir}/event`)) {
          const ev = JSON.parse(readFileSync(`${dir}/event`, 'utf8'))
          rmSync(`${dir}/event`)
          h.onMessage({ chatType: 'group', ...ev })
        }
        if (existsSync(`${dir}/recall`)) {
          const id = readFileSync(`${dir}/recall`, 'utf8').trim()
          rmSync(`${dir}/recall`)
          h.onRecall(id)
        }
      }, 50)
    },
  }
}
