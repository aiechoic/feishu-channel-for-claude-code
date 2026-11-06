import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('Codex setup emits isolated MCP fragment with tools-only mode and quoted paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex setup '))
  try {
    const r = spawnSync(process.execPath, ['bin/setup.mjs', '--codex', join(dir, 'config.json')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const fragment = readFileSync(join(dir, 'codex.config.toml'), 'utf8')
    assert.match(fragment, /FEISHU_CODEX_TOOLS_ONLY = "1"/)
    assert.match(fragment, /\[mcp_servers.feishu\]/)
    assert.match(r.stdout, /codex.mjs/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
