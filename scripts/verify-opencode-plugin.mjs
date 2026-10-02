// Offline checks for the companion against the OpenCode v2 Promise plugin
// contract: tool.transform(editor), session.hook('context'), and ToolContext.
import assert from 'node:assert/strict'
import test from 'node:test'
import companion from '../lib/opencode/index.js'
import { toolBridgeEnvironment } from '../lib/index.js'

const schema = { name: 'plugin_a', description: 'Use the DSH plugin', parameters: { type: 'object', properties: {} } }

async function withCompanion(run, reply = () => ({ status: 200, body: { tools: [schema], system: 'Harness system instruction' } })) {
  const names = ['DSH_OPENCODE_BRIDGE_URL', 'DSH_OPENCODE_BRIDGE_TOKEN']
  const previousEnvironment = new Map(names.map((name) => [name, process.env[name]]))
  const originalFetch = globalThis.fetch
  const requests = []
  const tools = new Map()
  const namespaces = []
  const hooks = new Map()
  const disposed = []
  let teardown
  process.env.DSH_OPENCODE_BRIDGE_URL = 'http://127.0.0.1:54321'
  process.env.DSH_OPENCODE_BRIDGE_TOKEN = 'test-transport-token'
  globalThis.fetch = async (url, init) => {
    const request = { url, init, body: JSON.parse(init.body) }
    requests.push(request)
    const response = await reply(request)
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  }
  const ctx = {
    tool: {
      transform: async (transform) => {
        transform({ namespace: (namespace) => namespaces.push(namespace), add: (tool) => tools.set(tool.name, tool) })
        return { dispose: async () => { disposed.push('tools') } }
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback)
        return { dispose: async () => { disposed.push(`session:${name}`) } }
      },
    },
  }
  try {
    const release = await companion.setup(ctx)
    let released = false
    teardown = async () => {
      if (released) return
      released = true
      await release?.()
    }
    await run({ ctx, tools, namespaces, hooks, requests, disposed, teardown })
  } finally {
    await teardown?.()
    globalThis.fetch = originalFetch
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

await test('the native companion registers the generic DSH tool namespace and a context hook', async () => {
  await withCompanion(async ({ tools, namespaces, hooks }) => {
    assert.equal(namespaces[0].name, 'dsh')
    assert.deepEqual([...tools.keys()], ['list', 'call'])
    for (const tool of tools.values()) {
      assert.equal(tool.options.namespace, 'dsh')
      assert.equal(tool.options.codemode, false)
      assert.equal(tool.input.type, 'object')
    }
    assert.ok(hooks.has('context'))
  })
})

await test('bound native requests receive the Harness system and exact tool schemas', async () => {
  await withCompanion(async ({ hooks, requests }) => {
    const context = { sessionID: 'provider-a', system: [], tools: { dsh_list: {}, dsh_call: {}, native_read: {} } }
    await hooks.get('context')(context)
    assert.ok(context.system.some((part) => part.text.includes('Harness system instruction')))
    assert.ok(context.system.some((part) => part.text.includes(JSON.stringify([schema]))))
    assert.ok(Object.hasOwn(context.tools, 'native_read'))
    assert.equal(requests[0].body.sessionId, 'provider-a')
    assert.equal(requests[0].init.headers.Authorization, 'Bearer test-transport-token')
  })
})

await test('unbound native sessions hide DSH tools while preserving their other tools', async () => {
  await withCompanion(async ({ hooks }) => {
    const native = { description: 'Read a file', input: { type: 'object' } }
    const context = { sessionID: 'unbound', system: [], tools: { dsh_list: {}, dsh_call: {}, native_read: native } }
    await hooks.get('context')(context)
    assert.deepEqual(context.tools, { native_read: native })
    assert.equal(context.system.length, 0)
  }, () => ({ status: 403, body: { error: 'No active DSH tool session' } }))
})

await test('a concluded DSH turn disables native tools before the final model response', async () => {
  await withCompanion(async ({ hooks }) => {
    const context = { sessionID: 'provider-a', system: [], tools: { dsh_call: {}, native_shell: {} } }
    await hooks.get('context')(context)
    assert.deepEqual(context.tools, {})
    assert.ok(context.system.some((part) => /concluded this turn/i.test(part.text)))
  }, () => ({ status: 200, body: { tools: [schema], concluded: true } }))
})

await test('native DSH calls retain their scope, signal, error outcome, and plugin-supplied context', async () => {
  const outcome = {
    isError: true, content: [{ type: 'text', text: 'Denied by policy' }],
    error: { message: 'Denied by policy', info: { name: 'PolicyDeniedError', code: 'POLICY_DENIED' } },
    meta: { title: 'Denied' }, additionalContexts: [{ role: 'user', content: [{ type: 'text', text: 'Use a permitted action' }] }],
  }
  await withCompanion(async ({ tools, requests }) => {
    const signal = new AbortController().signal
    const response = await tools.get('call').execute({ name: 'plugin_a', arguments: { value: 'requested' } }, {
      sessionID: 'provider-a', id: 'native-call-id', signal,
    })
    assert.deepEqual(JSON.parse(response.content), outcome)
    assert.deepEqual(requests[0].body, { sessionId: 'provider-a', callId: 'native-call-id', name: 'plugin_a', arguments: { value: 'requested' } })
    assert.equal(requests[0].init.signal, signal)
  }, () => ({ status: 200, body: outcome }))
})

await test('disposing the native companion releases its registrations in reverse order', async () => {
  await withCompanion(async ({ teardown, disposed }) => {
    await teardown()
    assert.deepEqual(disposed, ['session:compaction', 'session:context', 'tools'])
  })
})

await test('child environment adds the companion while preserving existing OpenCode configuration', async () => {
  const previous = process.env.OPENCODE_CONFIG_CONTENT
  const config = { plugins: ['existing-plugin'], model: 'opencode/existing', mcp: { fixture: { type: 'local', command: ['node', 'existing.js'] } }, permission: { shell: 'ask' } }
  try {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
    const environment = await toolBridgeEnvironment({ start: async () => ({ baseUrl: 'http://127.0.0.1:54321', token: 'private-fixture-token' }) }, 'D:\\fixture\\companion')
    assert.deepEqual(JSON.parse(environment.OPENCODE_CONFIG_CONTENT), { ...config, plugins: ['existing-plugin', 'D:\\fixture\\companion'] })
    assert.equal(environment.DSH_OPENCODE_BRIDGE_URL, 'http://127.0.0.1:54321')
    assert.equal(environment.DSH_OPENCODE_BRIDGE_TOKEN, 'private-fixture-token')
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, JSON.stringify(config), 'the parent Host configuration was modified')
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = previous
  }
})

await test('DSH context and replay retain their roles outside the recorded human prompt', async () => {
  const human = { id: 'msg_current', role: 'user', content: [{ type: 'text', text: 'roses are red' }] }
  const nativeTool = { role: 'tool', content: [{ type: 'tool-result', id: 'call', name: 'read', result: { type: 'text', value: 'done' } }] }
  await withCompanion(async ({ hooks, requests }) => {
    const context = { sessionID: 'provider-a', system: [], messages: [human, nativeTool], tools: { dsh_list: {}, dsh_call: {}, native_read: {} } }
    await hooks.get('context')(context)
    assert.ok(requests[0].url.endsWith('/context'))
    assert.deepEqual(context.messages.map(m => m.role), ['user', 'assistant', 'user', 'user', 'tool'])
    assert.deepEqual(context.messages.map(m => m.content[0].text).slice(0, 4), ['earlier question', 'earlier answer', '<system-reminder>skills</system-reminder>', 'roses are red'])
    assert.equal(context.messages.at(-2), human)
    assert.equal(context.messages.at(-1), nativeTool)
    assert.ok(!context.system.some(p => p.text.includes('<system-reminder>')))
    assert.deepEqual(context.tools, { native_read: {} }, 'context-only binding must hide DSH tools')
    assert.ok(hooks.has('compaction'), 'replayed history must participate in native compaction')
  }, () => ({ status: 200, body: { tools: [], context: {
    before: 'msg_current',
    messages: [{ role: 'user', text: '<system-reminder>skills</system-reminder>' }],
    replay: [{ before: 'msg_current', messages: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }] }],
  } } }))
})

await test('compaction receives replay and context even after a DSH tool concludes', async () => {
  await withCompanion(async ({ hooks }) => {
    assert.ok(hooks.has('compaction'))
    const context = { sessionID: 'provider-a', system: [], messages: [{ id: 'msg_current', role: 'user', content: [{ type: 'text', text: 'now' }] }], tools: {} }
    await hooks.get('compaction')(context)
    assert.equal(context.messages[0].content[0].text, 'past')
    assert.ok(context.system.some(p => p.text === 'DSH system'))
  }, () => ({ status: 200, body: { tools: [], concluded: true, system: 'DSH system', context: { before: 'msg_current', messages: [], replay: [{ before: 'msg_current', messages: [{ role: 'assistant', text: 'past' }] }] } } }))
})


await test('compaction includes replay anchored to its omitted recent slice', async () => {
  await withCompanion(async ({ hooks, requests }) => {
    const older = { sessionID: 'provider-a', system: [], messages: [{ id: 'msg_older', role: 'user', content: [{ type: 'text', text: 'older native question' }] }], tools: {} }
    await hooks.get('compaction')(older)
    assert.ok(older.messages.some(message => message.content[0].text === 'CRITICAL imported history'))
    assert.equal(older.messages[0].id, 'msg_older', 'recent-slice replay must follow older native history')
    assert.equal(older.messages[1].content[0].text, 'CRITICAL imported history')
    assert.equal(requests[0].body.phase, 'compaction')
    const resumed = { sessionID: 'provider-a', system: [], messages: [{ id: 'checkpoint', role: 'user', content: [{ type: 'text', text: 'summarized native checkpoint' }] }], tools: {} }
    await hooks.get('context')(resumed)
    assert.deepEqual(requests[1].body.messageIds, ['checkpoint'])
    assert.equal(resumed.messages.length, 1, 'already summarized history must not be resurrected')
  }, () => ({ status: 200, body: { tools: [], context: { before: 'msg_recent', messages: [], replay: [{ before: 'msg_recent', messages: [{ role: 'assistant', text: 'CRITICAL imported history' }] }] } } }))
})
