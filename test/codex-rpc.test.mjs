import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexRpc } from '../src/codex-rpc.mjs'

test('proxy is WebSocket framed over stdio; correlated replies and RPC errors work', async () => {
  const rpc = new CodexRpc(process.execPath, ['test/fake-codex-proxy.mjs', 'proxy'])
  try {
    await rpc.initialize()
    const results = await Promise.all([rpc.request('one', { n: 1 }), rpc.request('two', { n: 2 })])
    assert.deepEqual(results, [{ method: 'one', params: { n: 1 } }, { method: 'two', params: { n: 2 } }])
    await assert.rejects(rpc.request('error', {}), /expected failure/)
  } finally { rpc.close() }
})
