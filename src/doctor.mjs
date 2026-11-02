// 自检：按功能查应用权限，对比部署方清单。事件订阅没有查询接口，只能列出来请人核对。
// anyOf 里有一项已开通就够；core 缺了收发跑不起来，其余只报影响。
export const NEEDS = [
  { feature: '拉群列表', core: true, anyOf: ['im:chat', 'im:chat:read', 'im:chat:readonly'], effect: '找不到机器人所在的群，补漏失效' },
  { feature: '收消息（群或私信）', core: true, anyOf: ['im:message.group_msg', 'im:message.group_at_msg:readonly', 'im:message.p2p_msg:readonly'], effect: '收不到任何消息' },
  { feature: '拉历史消息', core: true, anyOf: ['im:message:readonly', 'im:message'], effect: '消息内容靠它取，收不到正文也无法补漏' },
  { feature: '发消息 / 回复', core: true, anyOf: ['im:message:send_as_bot', 'im:message'], effect: 'reply 工具和回执发不出去' },
  { feature: '收群里全部消息', anyOf: ['im:message.group_msg'], effect: '群里只收得到 @ 机器人的消息，「停」也要 @ 才行，而整条是「停」时又带不了 @' },
  { feature: '收私信', anyOf: ['im:message.p2p_msg:readonly'], effect: '收不到私信' },
  { feature: '加表情', anyOf: ['im:message.reactions:write_only', 'im:message'], effect: '消息上不显示排队 / 处理中 / 完成' },
  { feature: '更新状态卡片', anyOf: ['im:message:update', 'im:message', 'im:message:send_as_bot'], effect: '状态卡片停在第一次发出的内容' },
  { feature: '置顶状态卡片', anyOf: ['im:message.pins:write_only', 'im:message', 'im:message:send_as_bot'], effect: '状态卡片不会置顶' },
  { feature: '撤回识别', anyOf: ['im:message:readonly', 'im:message'], effect: '撤回事件和轮询都可能不工作，撤回的消息照常送达' },
]

export const EVENTS = [
  { name: 'im.message.receive_v1', effect: '收不到实时消息，只能靠定时补漏' },
  { name: 'im.message.recalled_v1', effect: '撤回只能靠轮询发现' },
]

export function checkScopes(granted, expected) {
  const has = new Set(granted)
  const missing = NEEDS.filter(n => !n.anyOf.some(s => has.has(s)))
  const want = new Set(expected ?? [])
  return {
    missing,
    coreMissing: missing.filter(n => n.core),
    extra: expected ? granted.filter(s => !want.has(s)).sort() : [],
    absent: expected ? [...want].filter(s => !has.has(s)).sort() : [],
  }
}

export function report(r, expected) {
  const lines = []
  for (const n of NEEDS) {
    const miss = r.missing.includes(n)
    lines.push(`${miss ? '缺' : 'OK'} ${n.feature}${miss ? `（需要 ${n.anyOf.join(' 或 ')}），影响：${n.effect}` : ''}`)
  }
  if (expected) {
    lines.push(`对比部署清单 ${expected.length} 项：少了 ${r.absent.length} 项，多了 ${r.extra.length} 项`)
    r.absent.forEach(s => lines.push(`  少了 ${s}`))
    r.extra.forEach(s => lines.push(`  多了 ${s}`))
  }
  lines.push('事件订阅无法自动检查，开放平台没有查询接口。请到后台「事件与回调」手动核对，订阅方式选长连接：')
  EVENTS.forEach(e => lines.push(`  ${e.name}：没订的话${e.effect}`))
  return lines.join('\n')
}
