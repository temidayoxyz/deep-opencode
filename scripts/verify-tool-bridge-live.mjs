// OpenCode itself must load the companion and invoke a DSH tool through the
// authenticated transport. The fixture Host owns only its temporary workspace.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessToolBridge, OpenCodeClient, OpenCodeFreeAdapter, OpenCodeServerPool, SessionRegistry, authorizationHeader, refreshCatalog, toolBridgeEnvironment } from '../lib/index.js'

const temporaryRoot = resolve(tmpdir())
const workspace = resolve(mkdtempSync(join(temporaryRoot, 'deep-opencode-bridge-')))
const marker = 'DSH_NATIVE_TOOL_BRIDGE_OK'
const events = []
const executions = []
const nativeEvents = new Map()
const agent = { id: 'ses_bridge_fixture', session: { append(type, data, options) {
  const event = { seq: events.length + 1, type, data, options }
  events.push(event)
  return event
} } }
const host = {
  agents: { get: id => id === agent.id ? agent : undefined },
  position: () => ({ turn: 1, step: 1 }),
  tools: { execute: async input => {
    assert.equal(input.agent, agent)
    assert.equal(input.name, 'fixture_write_marker')
    assert.deepEqual(input.arguments, { value: marker })
    input.signal.throwIfAborted()
    executions.push(input)
    writeFileSync(join(workspace, 'bridge-marker.txt'), input.arguments.value, 'utf8')
    console.log('DSH TOOL EXECUTED', input.name)
    return { isError: false, value: { path: 'bridge-marker.txt' }, content: [{ type: 'text', text: `${marker}: written through the DSH tool runtime` }], meta: { title: 'DSH bridge verified' } }
  } },
}
const bridge = new HarnessToolBridge(() => host)
const pluginDirectory = fileURLToPath(new URL('../lib/opencode/', import.meta.url))
const executable = join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe')
const pool = new OpenCodeServerPool({ opencodeCommand: existsSync(executable) ? executable : 'opencode', host: '127.0.0.1', port: 0, startupTimeoutMs: 120_000 }, () => toolBridgeEnvironment(bridge, pluginDirectory))
const registry = new SessionRegistry()
const adapter = new OpenCodeFreeAdapter(pool, workspace, () => workspace, 600_000, 60_000, registry, true, false, {
  toolBridge: bridge,
  onPermission: () => 'reject',
  onEvent: ({ event }) => {
    nativeEvents.set(event.type, (nativeEvents.get(event.type) ?? 0) + 1)
    if (/^session\.tool\.(called|success|failed)$/.test(event.type)) console.log('NATIVE', event.type, event.data?.name ?? event.data?.id, JSON.stringify(event.data?.error ?? ''))
  },
})
const server = pool.forDirectory(undefined, workspace)
const client = new OpenCodeClient(server)
const started = Date.now()
const progress = setInterval(() => console.log(`PROGRESS ${Math.round((Date.now() - started) / 1000)}s dsh-calls=${executions.length}`), 10_000)

try {
  console.log('OPENCODE', JSON.stringify(await client.info()))
  const address = await server.start()
  const get = async path => {
    const response = await fetch(address.baseUrl + path, { headers: { Authorization: authorizationHeader(address.password) }, signal: AbortSignal.timeout(30_000) })
    const body = await response.json()
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`)
    return body
  }
  await client.listModels()
  let plugins
  let companion
  const activationDeadline = Date.now() + 60_000
  do {
    plugins = await get('/api/plugin')
    companion = plugins.data?.find(plugin => plugin.id === 'dsh-tool-bridge')
    if (companion !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  } while (Date.now() < activationDeadline)
  console.log('PLUGINS', JSON.stringify(plugins.data?.filter(plugin => plugin.id === 'dsh-tool-bridge' || plugin.state?.status !== 'active')))
  assert.equal(companion?.state.status, 'active', 'the native companion must be active')
  if (process.argv.includes('--smoke')) {
    console.log('PASS OpenCode loaded the DSH native companion')
  } else {
    const models = await refreshCatalog(client)
    const model = process.env.OPENCODE_TEST_MODEL === undefined
      ? models.find(entry => /lightning/i.test(entry.id)) ?? models.find(entry => entry.id === 'big-pickle') ?? models[0]
      : models.find(entry => entry.id === process.env.OPENCODE_TEST_MODEL)
    assert.ok(model, 'no free model discovered')
    console.log('MODEL', model.id)
    let text = ''
    let finish
    let usage
    for await (const chunk of adapter.stream({ provider: 'opencode-free', model: model.id, sessionId: agent.id,
      system: 'This is a tool integration test. You must use the DSH fixture_write_marker tool exactly once, through dsh_call. The fixture tool owns its file operation; do not use shell or native file tools.',
      tools: [{ name: 'fixture_write_marker', description: 'Write the integration marker into the temporary project. This DSH tool must be called once.', parameters: { type: 'object', properties: { value: { type: 'string', enum: [marker] } }, required: ['value'], additionalProperties: false } }],
      messages: [{ id: 'u_bridge', role: 'user', content: [{ type: 'text', text: `Call dsh_call now with name "fixture_write_marker" and arguments {"value":"${marker}"}. This is the only action required. Then report the tool result and stop. Do not use other tools or merely describe a call.` }] }],
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
      if (chunk.type === 'usage') usage = chunk.usage
      assert.notEqual(chunk.type, 'tool-call-start', 'DSH must not dispatch the already executed bridge call twice')
    }
    assert.equal(finish?.kind, 'stop', JSON.stringify(finish))
    assert.ok(usage?.inputTokens > 0, 'native agent usage must survive the bridge')
    assert.equal(executions.length, 1)
    assert.equal(readFileSync(join(workspace, 'bridge-marker.txt'), 'utf8'), marker)
    assert.deepEqual(events.map(event => event.type), ['assistant/message', 'tool/call', 'tool/result'])
    assert.equal(events[2].data.message.content[0].toolCallId, executions[0].callId)
    console.log('RESPONSE', text)
    console.log('EVENTS', JSON.stringify(Object.fromEntries(nativeEvents)))
    console.log('PASS native companion loading, real model tool call, live DSH agent identity, canonical tool history, exactly-once execution, token usage')
  }
} catch (error) {
  console.error('FAILED EVENTS', JSON.stringify(Object.fromEntries(nativeEvents)))
  throw error
} finally {
  clearInterval(progress)
  await adapter.dispose()
  await registry.deleteSessions(registry.drain())
  try { await pool.stopAll() } finally { await bridge.dispose() }
  const ownedPath = relative(temporaryRoot, workspace)
  if (ownedPath.startsWith('..') || resolve(temporaryRoot, ownedPath) !== workspace || !ownedPath.startsWith('deep-opencode-bridge-')) throw new Error('Refusing to remove an unexpected test directory')
  try { rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  catch (error) { console.warn(`Test workspace retained at ${workspace}: ${error.message}`) }
}
