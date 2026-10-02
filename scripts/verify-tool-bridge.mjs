// Exercise the real local HTTP transport with a fake DSH Host. This boundary
// must preserve the live agent, normal tool policies, and canonical session log.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { HarnessToolBridge } from '../lib/index.js'

const schema = (name) => ({
  name,
  description: `Run ${name} through its DSH plugin`,
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
})
const result = (value = 'done') => ({ isError: false, content: [{ type: 'text', text: value }], value: { value } })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function bounded(promise, ms = 800) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the expected bridge event did not arrive')), ms)
    })])
  } finally { clearTimeout(timer) }
}

function fakeHost() {
  const logs = new Map()
  const executions = []
  const agents = new Map()
  for (const id of ['harness-a', 'harness-b']) {
    const events = []
    logs.set(id, events)
    agents.set(id, {
      id, ctx: {},
      session: {
        append(type, data, options) {
          const event = { seq: events.length + 100, type, data, options }
          events.push(event)
          return event
        },
      },
    })
  }
  const host = {
    agents: { get: (id) => agents.get(id) },
    tools: { execute: async (execution) => { executions.push(execution); return result(execution.arguments.value) } },
    position: () => ({ turn: 1, step: 1 }),
  }
  return { host, agents, logs, executions }
}

async function withBridge(run, configure = () => undefined) {
  const fixture = fakeHost()
  let currentHost = fixture.host
  const bridge = new HarnessToolBridge(() => currentHost)
  const bindings = []
  const controller = new AbortController()
  configure(fixture)
  const address = await bridge.start()
  const bind = async (overrides = {}) => {
    const binding = await bridge.bind({
      harnessSessionId: 'harness-a', providerSessionId: 'provider-a',
      tools: [schema('plugin_a')], signal: controller.signal, model: 'fixture-free', ...overrides,
    })
    bindings.push(binding)
    return binding
  }
  const post = async (path, body, headers = {}, signal = AbortSignal.timeout(2000)) => {
    const response = await fetch(address.baseUrl + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = text }
    return { response, data }
  }
  const call = (overrides = {}, headers, signal) => post('/tools/call', {
    sessionId: 'provider-a', name: 'plugin_a', arguments: { value: 'done' }, callId: 'native-id', ...overrides,
  }, headers, signal)
  try {
    await run({ ...fixture, bridge, bind, post, call, address, controller,
      setHost: (value) => { currentHost = value } })
  } finally {
    controller.abort()
    await Promise.allSettled(bindings.map((binding) => binding.close()))
    await bridge.dispose()
  }
}

function successful(response) {
  assert.equal(response.response.status, 200, JSON.stringify(response.data))
  return response.data.result ?? response.data
}
function denied(response) { assert.ok(!response.response.ok, 'an unauthorized call was accepted') }
function canonicalToolResult(message, callId, content, isError) {
  const { id: expectedId, ...expected } = createToolResultMessage({ callId, content, isError })
  const { id, ...actual } = message
  assert.equal(typeof id, 'string')
  assert.deepEqual(actual, expected, 'the installed Harness message factory defines the durable tool-result shape')
}

await test('tool discovery exposes only the schemas bound to the current provider session', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, post, address }) => {
    assert.match(address.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(typeof address.token, 'string')
    assert.ok(address.token.length >= 24, 'the transport token must not be predictable')
    await bind()
    const listing = successful(await post('/tools/list', { sessionId: 'provider-a' }))
    assert.deepEqual(listing.tools ?? listing, [schema('plugin_a')])
    denied(await post('/tools/list', { sessionId: 'unbound-provider' }))
  })
})

await test('a native tool call executes under its exact live DSH agent and records canonical events', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, agents, logs, executions }) => {
    await bind()
    const output = successful(await call({ harnessSessionId: 'harness-b' }))
    assert.equal(output.isError, false)
    assert.deepEqual(output.content, result().content)
    assert.equal(executions.length, 1)
    assert.equal(executions[0].agent, agents.get('harness-a'), 'the HTTP caller cannot substitute a different agent')
    assert.equal(executions[0].name, 'plugin_a')
    assert.deepEqual(executions[0].arguments, { value: 'done' })
    assert.ok(executions[0].signal instanceof AbortSignal)
    const events = logs.get('harness-a')
    assert.deepEqual(events.map((event) => event.type), ['assistant/message', 'tool/call', 'tool/result'])
    assert.equal(logs.get('harness-b').length, 0)
    const [message, invocation, completion] = events
    assert.equal(message.data.turn, 1)
    assert.equal(message.data.step, 1)
    assert.equal(message.options.surfaceOp, 'append')
    assert.deepEqual(message.data.stream, [])
    assert.equal(message.data.message.role, 'assistant')
    assert.equal(message.data.message.source.provider, 'opencode-free')
    assert.equal(message.data.message.source.model, 'fixture-free')
    const block = message.data.message.content[0]
    assert.equal(block.type, 'tool-call')
    assert.equal(block.id, executions[0].callId)
    assert.equal(block.name, 'plugin_a')
    assert.deepEqual(JSON.parse(block.arguments), { value: 'done' })
    assert.equal(invocation.data.callId, executions[0].callId)
    assert.equal(invocation.data.name, 'plugin_a')
    assert.deepEqual(JSON.parse(invocation.data.arguments), { value: 'done' })
    assert.equal(completion.data.turn, 1)
    assert.equal(completion.data.step, 1)
    assert.equal(completion.options.surfaceOp, 'append')
    assert.deepEqual(completion.options.sourceEventSeqs, [invocation.seq])
    canonicalToolResult(completion.data.message, invocation.data.callId, output.content, false)
  })
})

await test('tool policy denial and presentation metadata survive transport and durable logging', { timeout: 4000 }, async () => {
  const deniedResult = {
    isError: true, content: [{ type: 'text', text: 'Denied by the project policy' }],
    error: { message: 'Denied by the project policy', info: { name: 'PolicyDeniedError', code: 'POLICY_DENIED', reason: 'Restricted operation' } },
    meta: { card: 'generic', title: 'Blocked plugin call' },
  }
  await withBridge(async ({ bind, call, logs }) => {
    await bind()
    const output = successful(await call())
    assert.equal(output.isError, true)
    assert.deepEqual(output.content, deniedResult.content)
    assert.deepEqual(output.error, deniedResult.error)
    const completion = logs.get('harness-a').find((event) => event.type === 'tool/result')
    canonicalToolResult(completion.data.message, logs.get('harness-a')[1].data.callId, deniedResult.content, true)
    assert.deepEqual(completion.data.error, deniedResult.error.info)
    assert.deepEqual(completion.data.meta, deniedResult.meta)
  }, ({ host }) => { host.tools.execute = async () => deniedResult })
})

await test('plugin-supplied context keeps its message identity and appends after the tool result', { timeout: 4000 }, async () => {
  const context = createUserMessage({
    content: [{ type: 'text', text: 'A plugin supplied this follow-up context' }],
    source: { kind: 'plugin', plugin: 'fixture-context' },
  })
  await withBridge(async ({ bind, call, logs }) => {
    await bind()
    const output = successful(await call())
    assert.deepEqual(output.additionalContexts, [context])
    const events = logs.get('harness-a')
    assert.deepEqual(events.map((event) => event.type), ['assistant/message', 'tool/call', 'tool/result', 'user/message'])
    assert.equal(events[3].data, context, 'the canonical plugin message was replaced or wrapped')
    assert.deepEqual(events[3].options, { surfaceOp: 'append' })
  }, ({ host }) => { host.tools.execute = async () => ({ ...result(), additionalContexts: [context] }) })
})

await test('duplicate provider call IDs replay a settled result without re-executing or re-logging', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, executions, logs }) => {
    await bind()
    const first = successful(await call())
    const replay = successful(await call())
    assert.deepEqual(replay, first)
    assert.equal(executions.length, 1)
    assert.equal(logs.get('harness-a').length, 3)
    denied(await call({ arguments: { value: 'changed' } }))
    assert.equal(executions.length, 1, 'a reused call ID with new arguments must not dispatch')
  })
})

await test('duplicate IDs arriving during execution share one in-flight outcome', { timeout: 4000 }, async () => {
  const started = deferred()
  const complete = deferred()
  try {
    await withBridge(async ({ bind, call, executions, logs }) => {
      await bind()
      const first = call()
      await bounded(started.promise)
      const duplicate = call()
      await pause(20)
      complete.resolve()
      const outcomes = await Promise.all([first, duplicate])
      assert.deepEqual(successful(outcomes[0]), successful(outcomes[1]))
      assert.equal(executions.length, 1)
      assert.equal(logs.get('harness-a').length, 3)
    }, ({ host, executions }) => {
      host.tools.execute = async (execution) => {
        executions.push(execution)
        started.resolve()
        await complete.promise
        return result()
      }
    })
  } finally { complete.resolve() }
})

await test('unbound sessions and tools outside a binding cannot execute or append events', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, executions, logs }) => {
    await bind()
    await bind({ harnessSessionId: 'harness-b', providerSessionId: 'provider-b', tools: [schema('plugin_b')] })
    for (const request of [
      { sessionId: 'unbound-provider' },
      { name: 'plugin_b' },
      { name: 'unknown_plugin' },
      { sessionId: 'provider-b', name: 'plugin_a' },
    ]) denied(await call(request))
    assert.equal(executions.length, 0)
    assert.equal(logs.get('harness-a').length, 0)
    assert.equal(logs.get('harness-b').length, 0)
  })
})

await test('calls within a binding run serially through the DSH tool registry', { timeout: 4000 }, async () => {
  const started = deferred()
  const complete = deferred()
  let active = 0
  let maxActive = 0
  try {
    await withBridge(async ({ bind, call, executions }) => {
      await bind()
      const first = call({ callId: 'first' })
      await bounded(started.promise)
      const second = call({ callId: 'second', arguments: { value: 'second' } })
      await pause(20)
      complete.resolve()
      for (const outcome of await Promise.all([first, second])) successful(outcome)
      assert.equal(executions.length, 2)
      assert.equal(maxActive, 1, 'calls overlapped inside the live DSH step')
    }, ({ host, executions }) => {
      host.tools.execute = async (execution) => {
        executions.push(execution)
        active++
        maxActive = Math.max(maxActive, active)
        if (executions.length === 1) { started.resolve(); await complete.promise }
        active--
        return result(execution.arguments.value)
      }
    })
  } finally { complete.resolve() }
})

await test('aborting a binding refuses new calls before any tool or durable event is produced', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, controller, executions, logs }) => {
    await bind()
    controller.abort()
    denied(await call())
    assert.equal(executions.length, 0)
    assert.equal(logs.get('harness-a').length, 0)
  })
})

await test('closing a binding aborts and drains cooperative execution before releasing its log', { timeout: 4000 }, async () => {
  const started = deferred()
  const aborted = deferred()
  const cleaned = deferred()
  try {
    await withBridge(async ({ bind, call, executions, logs }) => {
      const binding = await bind()
      const request = call()
      await bounded(started.promise)
      let closed = false
      const closing = binding.close().then(() => { closed = true })
      try {
        await bounded(aborted.promise)
        assert.equal(closed, false, 'close returned before the owned tool reached quiescence')
        denied(await call({ callId: 'after-close' }))
      } finally { cleaned.resolve() }
      await bounded(closing)
      const outcome = await request
      assert.ok(!outcome.response.ok || successful(outcome).isError, 'cancelled work returned success')
      assert.equal(executions.length, 1)
      assert.ok(executions[0].signal.aborted)
      assert.ok(logs.get('harness-a').some((event) => event.type === 'tool/result'))
    }, ({ host, executions }) => {
      host.tools.execute = async (execution) => {
        executions.push(execution)
        started.resolve()
        await new Promise((resolve) => {
          if (execution.signal.aborted) { aborted.resolve(); resolve(); return }
          execution.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true })
        })
        await cleaned.promise
        return { isError: true, content: [{ type: 'text', text: 'Cancelled' }] }
      }
    })
  } finally { cleaned.resolve() }
})

for (const unavailable of ['host', 'agent', 'step']) {
  await test(`binding fails when the live ${unavailable} is unavailable`, { timeout: 4000 }, async () => {
    await withBridge(async ({ bind, setHost, host, executions }) => {
      if (unavailable === 'host') setHost(undefined)
      if (unavailable === 'agent') host.agents.get = () => undefined
      if (unavailable === 'step') host.position = () => undefined
      await assert.rejects(async () => { await bind() })
      assert.equal(executions.length, 0)
    })
  })
}

await test('a binding stops dispatching when its Host services or live agent disappear', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, setHost, host, executions }) => {
    await bind()
    setHost(undefined)
    denied(await call())
    setHost(host)
    host.agents.get = () => undefined
    denied(await call({ callId: 'missing-agent' }))
    assert.equal(executions.length, 0)
  })
})

await test('explicit browser Origin and unauthenticated requests cannot access bound tools', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, post, executions }) => {
    await bind()
    for (const headers of [
      { Authorization: '' },
      { Authorization: 'Bearer incorrect-token' },
      { Origin: 'https://untrusted.example' },
      { Origin: 'http://127.0.0.1:3000' },
    ]) {
      denied(await call({}, headers))
      denied(await post('/tools/list', { sessionId: 'provider-a' }, headers))
    }
    assert.equal(executions.length, 0)
  })
})

await test('a binding cannot execute or advertise tools after its DSH step closes or advances', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, post, host, executions, logs }) => {
    await bind()
    for (const position of [undefined, { turn: 1, step: 2 }, { turn: 2, step: 1 }]) {
      host.position = () => position
      denied(await call({ callId: `stale-${position?.turn}-${position?.step}` }))
      denied(await post('/tools/list', { sessionId: 'provider-a' }))
    }
    assert.equal(executions.length, 0)
    assert.equal(logs.get('harness-a').length, 0)
  })
})

await test('queued tool calls recheck the current DSH step immediately before dispatch', { timeout: 4000 }, async () => {
  const started = deferred()
  const complete = deferred()
  try {
    await withBridge(async ({ bind, call, host, executions, logs }) => {
      await bind()
      const first = call({ callId: 'first' })
      await bounded(started.promise)
      const queued = call({ callId: 'queued', arguments: { value: 'must not run' } })
      await pause(20)
      host.position = () => ({ turn: 1, step: 2 })
      complete.resolve()
      successful(await first)
      denied(await queued)
      assert.equal(executions.length, 1)
      assert.equal(logs.get('harness-a').length, 3)
    }, ({ host, executions }) => {
      host.tools.execute = async (execution) => {
        executions.push(execution)
        if (executions.length === 1) { started.resolve(); await complete.promise }
        return result()
      }
    })
  } finally { complete.resolve() }
})

await test('successful concludesTurn results prohibit further native tool calls', { timeout: 4000 }, async () => {
  await withBridge(async ({ bind, call, post, executions }) => {
    const binding = await bind()
    const first = successful(await call())
    assert.equal(first.concludesTurn, true)
    assert.equal(binding.concluded, true)
    const catalogue = successful(await post('/tools/list', { sessionId: 'provider-a' }))
    assert.equal(catalogue.concluded, true)
    denied(await call({ callId: 'after-conclusion' }))
    assert.equal(executions.length, 1)
  }, ({ host, executions }) => {
    host.tools.execute = async (execution) => { executions.push(execution); return { ...result(), concludesTurn: true } }
  })
})

await test('a disconnected native caller cancels and drains its DSH tool execution', { timeout: 4000 }, async () => {
  const started = deferred()
  const cancelled = deferred()
  await withBridge(async ({ bind, call, executions, logs }) => {
    await bind()
    const controller = new AbortController()
    const request = call({}, undefined, controller.signal).catch((error) => error)
    await bounded(started.promise)
    controller.abort()
    await bounded(cancelled.promise)
    await request
    await pause(10)
    assert.equal(executions.length, 1)
    assert.ok(executions[0].signal.aborted)
    const completion = logs.get('harness-a').find((event) => event.type === 'tool/result')
    assert.ok(completion, 'cancelled owned work must still settle its canonical tool result')
    canonicalToolResult(completion.data.message, logs.get('harness-a')[1].data.callId,
      [{ type: 'text', text: 'Error: DSH tool call cancelled' }], true)
  }, ({ host, executions }) => {
    host.tools.execute = async (execution) => {
      executions.push(execution)
      started.resolve()
      await new Promise((resolve) => {
        execution.signal.addEventListener('abort', resolve, { once: true })
        if (execution.signal.aborted) resolve()
      })
      cancelled.resolve()
      return result('late success must become cancellation')
    }
  })
})

await test('disposing a bridge during listener startup settles the startup promise', { timeout: 4000 }, async () => {
  const bridge = new HarnessToolBridge(() => undefined)
  const starting = bridge.start().then((address) => ({ address }), (error) => ({ error }))
  try {
    await bridge.dispose()
    const settled = await bounded(starting)
    if (settled.address !== undefined) {
      await assert.rejects(fetch(settled.address.baseUrl + '/tools/list', {
        method: 'POST', signal: AbortSignal.timeout(200),
      }), 'the disposed loopback listener must be closed')
    }
    await assert.rejects(bridge.start())
  } finally { await bridge.dispose() }
})
