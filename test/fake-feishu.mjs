// 假飞书：消息来自 $FAKE/messages.json；$FAKE/fire 触发收消息事件，$FAKE/recall 触发撤回事件；发出去的动作记到文件
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'

const dir = process.env.FAKE
const all = () => JSON.parse(readFileSync(`${dir}/messages.json`, 'utf8'))

const brief = content => `${content.match(/忙|闲|离线/)?.[0] ?? ''} ${content.match(/下一个定时[^"\\]*/)?.[0] ?? ''}`

export function connect() {
  return {
    listChats: async () => ['oc_group'],
    async listMessages(chat) {
      if (existsSync(`${dir}/list-fail`)) {
        rmSync(`${dir}/list-fail`)
        throw new Error('EOF')
      }
      return { messages: all().filter(m => m.chat_id === chat).reverse(), hasMore: false }
    },
    getMessage: async id => all().find(m => m.message_id === id) ?? null,
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
        if (existsSync(`${dir}/recall`)) {
          const id = readFileSync(`${dir}/recall`, 'utf8').trim()
          rmSync(`${dir}/recall`)
          h.onRecall(id)
        }
      }, 50)
    },
  }
}
