import { createServer } from 'node:http'
import { connect } from 'node:net'
import { WebSocketServer } from 'ws'
const server = createServer()
const wss = new WebSocketServer({ server })
wss.on('connection', ws => ws.on('message', raw => {
  const m = JSON.parse(raw)
  if (m.id === undefined) return
  ws.send(JSON.stringify(m.method === 'error'
    ? { id: m.id, error: { message: 'expected failure' } }
    : { id: m.id, result: { method: m.method, params: m.params } }))
}))
server.listen(0, '127.0.0.1', () => {
  const socket = connect(server.address().port, '127.0.0.1')
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
process.stdin.on('end', () => process.exit(0))
