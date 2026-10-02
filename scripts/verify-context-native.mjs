// Real OpenCode persistence and context hooks, with a deterministic local model.
// All mutable runtime directories stay inside the owned workspace on D:.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessToolBridge, OpenCodeClient, OpenCodeFreeAdapter, OpenCodeServerPool, SessionRegistry, authorizationHeader, toolBridgeEnvironment } from '../lib/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = mkdtempSync(join(root, '.context-verification-'))
const requests = []
let overflowed = false
const mock = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push({ path: req.url, body })
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Unexpected fixture protocol: ${req.url}` } }))
    return
  }
  const contents = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
  const summary = contents.some(text => text.includes('<template>') && text.includes('## Objective'))
  if (!overflowed && contents.at(-1) === 'COMPACT_THIS_TURN') {
    overflowed = true
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'maximum context length exceeded' } }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const base = { id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model }
  const text = summary ? '## Objective\nRetain earlier question and earlier answer.\n\n## Work State\nCRITICAL_RECENT_REPLAY was supplied before the most recent prompt.' : 'LOCAL_CONTEXT_VERIFIED'
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const modelURL = `http://127.0.0.1:${mock.address().port}/v1`
const fixturePlugin = join(workspace, 'fixture-plugin')
mkdirSync(fixturePlugin)
writeFileSync(join(fixturePlugin, 'index.js'), `export default { id: 'local-context-fixture', async setup(ctx) {
  const registration = await ctx.session.hook('model.request', event => { event.baseURL = ${JSON.stringify(modelURL)}; event.headers = {}; });
  return () => registration.dispose();
} };`)
const runtime = Object.fromEntries(['data', 'state', 'cache', 'config', 'temp'].map(name => {
  const directory = join(workspace, name); mkdirSync(directory); return [name, directory]
}))
const bridge = new HarnessToolBridge(() => undefined)
const companion = fileURLToPath(new URL('../lib/opencode/', import.meta.url))
const binary = join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe')
const pool = new OpenCodeServerPool({ opencodeCommand: existsSync(binary) ? binary : 'opencode', host: '127.0.0.1', port: 0, startupTimeoutMs: 60_000 }, async () => ({
  ...await toolBridgeEnvironment(bridge, companion),
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [companion, fixturePlugin] }),
  XDG_DATA_HOME: runtime.data, XDG_STATE_HOME: runtime.state, XDG_CACHE_HOME: runtime.cache, XDG_CONFIG_HOME: runtime.config,
  TEMP: runtime.temp, TMP: runtime.temp,
}))
const registry = new SessionRegistry({ idleTtlMs: 0 })
const adapter = new OpenCodeFreeAdapter(pool, workspace, () => workspace, 60_000, 30_000, registry, true, false, { toolBridge: bridge })
const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const answer = (id, text) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'opencode-free', model: 'big-pickle' }, content: [{ type: 'text', text }] })
const injected = version => ({ id: 'runtime', role: 'user', source: { kind: 'plugin', plugin: 'skills' }, content: [{ type: 'text', text: `PRIVATE_DSH_CONTEXT_${version}` }] })
const run = async (sessionId, messages, purpose) => {
  let finish, text = ''
  for await (const chunk of adapter.stream({ provider: 'opencode-free', model: 'big-pickle', sessionId, system: 'PRIVATE_DSH_SYSTEM', tools: [], messages, purpose })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(finish?.kind, 'stop', JSON.stringify(finish))
  assert.equal(text, 'LOCAL_CONTEXT_VERIFIED')
  return text
}
try {
  const client = new OpenCodeClient(pool.forDirectory(undefined, workspace))
  console.log('OPENCODE', JSON.stringify(await client.info()))
  const address = await pool.forDirectory(undefined, workspace).start()
  const get = async path => {
    const response = await fetch(address.baseUrl + path, { headers: { Authorization: authorizationHeader(address.password) }, signal: AbortSignal.timeout(10_000) })
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body.data
  }
  // Native session entry points wait for plugin activation.
  const prefix = [user('past-u', 'earlier question'), answer('past-a', 'earlier answer')]
  const first = [...prefix, user('u1', 'roses are red'), injected(1)]
  const response = await run('clean-transcript', first)
  const providerSession = registry.providerSession('clean-transcript')
  const next = [...prefix, user('u1', 'roses are red'), answer('a1', response), user('u2', 'what did I say before?'), injected(2)]
  await run('clean-transcript', next)
  assert.equal(registry.providerSession('clean-transcript'), providerSession)
  const native = await get(`/api/session/${providerSession}/context`)
  const history = Array.isArray(native) ? native : native.messages
  assert.deepEqual(history.filter(m => m.type === 'user').map(m => m.text), ['roses are red', 'what did I say before?'])
  const turns = requests.filter(request => JSON.stringify(request.body).includes('PRIVATE_DSH_SYSTEM'))
  assert.equal(turns.length, 2)
  const visible = message => typeof message.content === 'string' ? message.content : message.content.map(p => p.text ?? '').join('')
  for (const [index, request] of turns.entries()) {
    const messages = request.body.messages
    assert.ok(messages.some(m => m.role === 'user' && visible(m) === 'earlier question'))
    assert.ok(messages.some(m => m.role === 'assistant' && visible(m) === 'earlier answer'))
    assert.ok(messages.some(m => m.role === 'user' && visible(m) === `PRIVATE_DSH_CONTEXT_${index + 1}`))
    assert.ok(messages.some(m => m.role === 'system' && visible(m).includes('PRIVATE_DSH_SYSTEM')))
    assert.ok(!messages.some(m => visible(m).includes('User: roses are red')))
  }
  await run('clean-transcript', [...next.slice(0, -1), answer('a2', 'LOCAL_CONTEXT_VERIFIED'),
    user('u3', 'CRITICAL_RECENT_REPLAY'), { ...answer('external-a', 'foreign assistant context'), source: { kind: 'model', provider: 'external', model: 'fixture' } },
    user('u4', 'COMPACT_THIS_TURN'), injected(3)])
  assert.ok(overflowed, 'the local fixture must force native overflow compaction')
  const summaries = requests.filter(request => JSON.stringify(request.body).includes('<template>'))
  assert.ok(summaries.some(request => request.body.messages.some(message => message.role === 'user' && message.content === 'CRITICAL_RECENT_REPLAY')), 'recent-slice replay was omitted from the real native summary request')
  const afterCompaction = requests.at(-1).body.messages
  assert.ok(afterCompaction.some(message => String(message.content).includes('<conversation-checkpoint>') && String(message.content).includes('CRITICAL_RECENT_REPLAY')))
  assert.ok(!afterCompaction.some(message => message.content === 'CRITICAL_RECENT_REPLAY'), 'summarized replay was duplicated after the checkpoint')
  const syntheticAnswer = await run('producer-only', [injected('TASK')])
  const syntheticSession = registry.providerSession('producer-only')
  await run('producer-only', [answer('synthetic-a', syntheticAnswer), injected('TASK_FOLLOWUP')])
  assert.equal(registry.providerSession('producer-only'), syntheticSession)
  await run('title-test', [injected('TITLE')], 'session-title')
  console.log('PASS real native history stores exact human messages; model receives DSH context and role-correct persistent replay; overflow compaction preserves recent-slice replay; synthetic continuations and auxiliary requests complete')
} finally {
  await adapter.dispose()
  await registry.deleteSessions(registry.drain())
  try { await pool.stopAll() } finally { await bridge.dispose() }
  await new Promise(resolve => { mock.close(resolve); mock.closeAllConnections() })
  const owned = relative(root, workspace)
  assert.ok(owned.startsWith('.context-verification-') && !owned.includes('..') && resolve(root, owned) === workspace)
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
