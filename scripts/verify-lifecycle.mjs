// Regression checks at the OpenCode client boundary. No process is started and
// no external model is called: the fake publishes the same session events that
// the real server publishes, while the real adapter and registry run unchanged.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OpenCodeClient,
  OpenCodeFreeAdapter,
  OpenCodeRequestError,
  SessionRegistry,
} from '../lib/index.js'

const user = (id, text) => ({ role: 'user', id, content: [{ type: 'text', text }] })
const assistant = (id, text) => ({ role: 'assistant', id, content: [{ type: 'text', text }] })
const options = (sessionId, messages, signal) => ({
  provider: 'opencode-free', model: 'test-free', sessionId, messages,
  ...(signal === undefined ? {} : { signal }),
})
const nextTick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

class EventFeed {
  items = []
  waiters = []
  closed = false

  push(event) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value: event, done: false })
    else this.items.push(event)
  }

  next() {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false })
    if (this.closed) return Promise.resolve({ done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  return() {
    this.closed = true
    this.items.length = 0
    for (const resolve of this.waiters.splice(0)) resolve({ done: true })
    return Promise.resolve({ done: true })
  }

  [Symbol.asyncIterator]() { return this }
}

async function collect(adapter, request) {
  const chunks = []
  try {
    for await (const chunk of adapter.stream(request)) chunks.push(chunk)
    return { chunks, error: undefined }
  } catch (error) {
    return { chunks, error }
  }
}

function failureCode(result) {
  return result.error?.code ?? result.chunks.find((chunk) =>
    chunk.type === 'finish' && chunk.reason.kind === 'error')?.reason.failure.code
}

function visibleText(result) {
  return result.chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

function assertSucceeded(result) {
  assert.equal(result.error, undefined, result.error?.message)
  const finishes = result.chunks.filter((chunk) => chunk.type === 'finish')
  assert.equal(finishes.length, 1, 'the delegated turn must have exactly one terminal result')
  assert.equal(finishes[0].reason.kind, 'stop')
}

// Prototype replacement keeps tests compatible with the adapter constructing
// its own client. Each fixture restores the boundary before the next case runs.
async function withFakeClient(run, settings = {}) {
  const methodNames = ['createSession', 'setModel', 'deleteSession', 'prompt', 'interrupt', 'events', 'replyPermission', 'replyForm']
  const original = new Map(methodNames.map((name) => [name, OpenCodeClient.prototype[name]]))
  const feeds = new Set()
  const pending = new Set()
  const state = {
    prompts: [], deleted: [], interrupted: [], permissionReplies: [], formReplies: [], active: new Map(), maxActive: 0,
    created: 0, message: 0,
  }
  const registry = new SessionRegistry({ maxSessions: 8, idleTtlMs: 0, turnGraceMs: 0, ...settings.policy })
  const pool = { forDirectory: () => ({ cwd: process.cwd() }), directories: [process.cwd()] }
  const adapter = new OpenCodeFreeAdapter(pool, process.cwd(), () => process.cwd(),
    settings.timeoutMs ?? 500, 100, registry, true, false, settings.integration)

  function track(promise) {
    pending.add(promise)
    promise.finally(() => pending.delete(promise)).catch(() => undefined)
    return promise
  }
  const pause = (ms) => track(new Promise((resolve) => setTimeout(resolve, ms)))
  const emit = (id, type, data = {}) => {
    const event = { type, data: id === undefined ? { ...data } : { sessionID: id, ...data } }
    for (const feed of feeds) feed.push(event)
  }
  const finish = (id, text = 'answer already stored by provider') => {
    const assistantMessageID = `message_${++state.message}`
    emit(id, 'session.text.started', { assistantMessageID, ordinal: 0 })
    emit(id, 'session.text.delta', { assistantMessageID, ordinal: 0, delta: text })
    emit(id, 'session.text.ended', { assistantMessageID, ordinal: 0, text })
    emit(id, 'session.step.ended', {
      assistantMessageID, finish: 'stop', tokens: { input: 2, output: 1 },
    })
    emit(id, 'session.execution.succeeded')
    state.active.set(id, Math.max(0, (state.active.get(id) ?? 1) - 1))
  }

  OpenCodeClient.prototype.createSession = async function () {
    if (settings.createDelayMs !== undefined) await pause(settings.createDelayMs)
    return `provider_${++state.created}`
  }
  OpenCodeClient.prototype.setModel = async function () {
    if (settings.modelDelayMs !== undefined) await pause(settings.modelDelayMs)
  }
  OpenCodeClient.prototype.deleteSession = async function (id) { state.deleted.push(id) }
  OpenCodeClient.prototype.events = function (signal) {
    const feed = new EventFeed()
    feeds.add(feed)
    signal.addEventListener('abort', () => { void feed.return(); feeds.delete(feed) }, { once: true })
    if (signal.aborted) void feed.return()
    else if (settings.connectionDelayMs !== undefined) {
      void pause(settings.connectionDelayMs).then(() => feed.push({ type: 'server.connected' }))
    } else feed.push({ type: 'server.connected' })
    return feed
  }
  OpenCodeClient.prototype.prompt = async function (id, text) {
    state.prompts.push({ id, text })
    if (settings.rejectFirstPrompt && state.prompts.length === 1) {
      throw new OpenCodeRequestError('the provider rejected the prompt', 'PROVIDER', 500)
    }
    if (settings.promptDelayMs !== undefined) await pause(settings.promptDelayMs)
    const active = (state.active.get(id) ?? 0) + 1
    state.active.set(id, active)
    state.maxActive = Math.max(state.maxActive, active)
    if (settings.onPrompt !== undefined) {
      await settings.onPrompt({ id, text, state, emit, finish, track })
    } else finish(id)
  }
  OpenCodeClient.prototype.interrupt = async function (id) {
    state.interrupted.push(id)
    state.active.set(id, 0)
  }
  OpenCodeClient.prototype.replyPermission = async function (id, request, decision) {
    state.permissionReplies.push({ id, request, decision })
    finish(id, 'The permitted work is complete.')
  }
  OpenCodeClient.prototype.replyForm = async function (id, form, answer) {
    state.formReplies.push({ id, form, answer })
    finish(id, 'The selected work is complete.')
  }

  try {
    await run({ adapter, registry, state, emit, finish })
  } finally {
    for (const feed of feeds) await feed.return()
    await adapter.dispose?.()
    // Stalled fake I/O is bounded and must settle before restoring the real
    // boundary; no late continuation can accidentally call a real server.
    while (pending.size > 0) await Promise.allSettled([...pending])
    await nextTick()
    for (const [name, implementation] of original) OpenCodeClient.prototype[name] = implementation
  }
}

await test('a session serializes the entire delegated execution', { timeout: 2500 }, async () => {
  const firstStarted = deferred()
  const completeFirst = deferred()
  try {
    await withFakeClient(async ({ adapter, state }) => {
      const first = collect(adapter, options('serialized', [user('u1', 'first question')]))
      await firstStarted.promise
      const second = collect(adapter, options('serialized', [user('u1', 'first question'), user('u2', 'second question')]))
      await nextTick()
      await nextTick()
      completeFirst.resolve()
      const results = await Promise.all([first, second])
      for (const result of results) assertSucceeded(result)
      assert.equal(state.maxActive, 1, 'two delegated executions overlapped in the same provider session')
    }, {
      onPrompt: ({ id, state, finish, track }) => {
        if (state.prompts.length === 1) {
          firstStarted.resolve()
          void track(completeFirst.promise.then(() => finish(id)))
        } else finish(id)
      },
    })
  } finally { completeFirst.resolve() }
})

await test('rejected prompts retain their context for the next turn', { timeout: 2500 }, async () => {
  await withFakeClient(async ({ adapter, state }) => {
    const firstHistory = [user('u1', 'CRITICAL CONTEXT that must survive rejection')]
    const failed = await collect(adapter, options('rejected', firstHistory))
    assert.ok(failureCode(failed), 'the fake rejection must be surfaced to the caller')
    assertSucceeded(await collect(adapter, options('rejected', [...firstHistory, user('u2', 'follow up')])))
    assert.ok(state.prompts[1].text.includes('CRITICAL CONTEXT'), 'the rejected context was lost on retry')
    assert.ok(state.prompts[1].text.includes('follow up'))
  }, { rejectFirstPrompt: true })
})

for (const [stage, settings] of [
  ['session creation', { createDelayMs: 120 }],
  ['model selection', { modelDelayMs: 120 }],
  ['event connection', { connectionDelayMs: 120 }],
  ['prompt acceptance', { promptDelayMs: 120 }],
]) {
  await test(`the turn deadline includes ${stage}`, { timeout: 2500 }, async () => {
    await withFakeClient(async ({ adapter }) => {
      const result = await collect(adapter, options(`timeout-${stage}`, [user('u1', 'hello')]))
      assert.equal(failureCode(result), 'TIMEOUT', `${stage} exceeded the deadline without timing out`)
    }, { ...settings, timeoutMs: 20 })
  })
}

await test('zero idle TTL keeps idle session mappings', async () => {
  const registry = new SessionRegistry({ maxSessions: 4, idleTtlMs: 0, turnGraceMs: 0 })
  await registry.adopt('no-expiry', 'provider_no_expiry')
  assert.deepEqual(await registry.reclaim(Date.now() + 24 * 60 * 60_000), [])
  assert.equal(registry.providerSession('no-expiry'), 'provider_no_expiry')
})

await test('adapter turns enforce the mapping bound and delete evicted provider sessions', { timeout: 2500 }, async () => {
  await withFakeClient(async ({ adapter, registry, state }) => {
    for (const id of ['one', 'two', 'three']) {
      assertSucceeded(await collect(adapter, options(id, [user(`u-${id}`, id)])))
    }
    assert.equal(registry.size, 2, 'adapter-created mappings bypassed the configured limit')
    assert.ok(state.deleted.includes('provider_1'), 'the evicted session must be deleted at its provider')
    assert.equal(registry.providerSession('three'), 'provider_3')
  }, { policy: { maxSessions: 2 } })
})

await test('follow-ups do not replay the provider answer as user content', { timeout: 2500 }, async () => {
  await withFakeClient(async ({ adapter, state }) => {
    const firstHistory = [user('u1', 'first question')]
    const first = await collect(adapter, options('follow-up', firstHistory))
    assertSucceeded(first)
    const answer = visibleText(first)
    assertSucceeded(await collect(adapter, options('follow-up', [
      ...firstHistory, assistant('a1', answer), user('u2', 'next question'),
    ])))
    assert.ok(!state.prompts[1].text.includes(answer), 'the provider already remembers its own answer')
    assert.ok(state.prompts[1].text.includes('next question'))
  })
})

await test('caller cancellation interrupts the active delegated execution', { timeout: 2500 }, async () => {
  const started = deferred()
  await withFakeClient(async ({ adapter, state }) => {
    const controller = new AbortController()
    const running = collect(adapter, options('cancelled', [user('u1', 'keep working')], controller.signal))
    await started.promise
    controller.abort()
    const result = await running
    assert.ok(failureCode(result), 'cancellation must terminate the caller request')
    assert.deepEqual(state.interrupted, ['provider_1'], 'closing SSE alone leaves the OpenCode agent running')
    assert.equal(state.active.get('provider_1'), 0)
  }, { onPrompt: () => { started.resolve() } })
})

await test('tool-call steps continue through the full delegated execution', { timeout: 2500 }, async () => {
  await withFakeClient(async ({ adapter, state }) => {
    const result = await collect(adapter, options('tool-loop', [user('u1', 'make the change and summarize it')]))
    assertSucceeded(result)
    assert.ok(visibleText(result).includes('The change is complete.'), 'the adapter stopped before the tool result and final answer')
    assert.equal(result.chunks.filter((chunk) => chunk.type === 'finish').length, 1)
    const usage = result.chunks.filter((chunk) => chunk.type === 'usage').at(-1)?.usage
    assert.equal(usage?.inputTokens, 7, 'usage must include both model steps')
    assert.equal(usage?.outputTokens, 3, 'usage must include both model steps')
    assert.equal(state.active.get('provider_1'), 0)
  }, {
    onPrompt: ({ id, state, emit }) => {
      emit(id, 'session.text.started', { assistantMessageID: 'tool-planning', ordinal: 0 })
      emit(id, 'session.text.delta', { assistantMessageID: 'tool-planning', ordinal: 0, delta: 'I will run the tool. ' })
      emit(id, 'session.text.ended', { assistantMessageID: 'tool-planning', ordinal: 0, text: 'I will run the tool. ' })
      emit(id, 'session.step.ended', {
        assistantMessageID: 'tool-planning', finish: 'tool_calls', tokens: { input: 2, output: 1 },
      })
      emit(id, 'session.text.started', { assistantMessageID: 'tool-summary', ordinal: 0 })
      emit(id, 'session.text.delta', { assistantMessageID: 'tool-summary', ordinal: 0, delta: 'The change is complete.' })
      emit(id, 'session.text.ended', { assistantMessageID: 'tool-summary', ordinal: 0, text: 'The change is complete.' })
      emit(id, 'session.step.ended', {
        assistantMessageID: 'tool-summary', finish: 'stop', tokens: { input: 5, output: 2 },
      })
      emit(id, 'session.execution.succeeded')
      state.active.set(id, 0)
    },
  })
})

await test('permission requests reach the host integration and the reply resumes execution', { timeout: 2500 }, async () => {
  const received = []
  await withFakeClient(async ({ adapter, state }) => {
    const result = await collect(adapter, options('permission', [user('u1', 'run the command')]))
    assertSucceeded(result)
    assert.deepEqual(state.permissionReplies, [{ id: 'provider_1', request: 'permission_1', decision: 'once' }])
    assert.equal(received.length, 1)
    assert.equal(received[0].harnessSessionId, 'permission')
    assert.equal(received[0].providerSessionId, 'provider_1')
    assert.ok(visibleText(result).includes('The permitted work is complete.'))
  }, {
    integration: { onPermission: (context) => { received.push(context); return 'once' } },
    onPrompt: ({ id, emit }) => emit(id, 'permission.asked', {
      id: 'permission_1', action: 'shell', resource: 'npm run build',
    }),
  })
})

await test('nested form requests reach the host integration and answers resume execution', { timeout: 2500 }, async () => {
  const received = []
  const answer = { target: 'src/app.ts' }
  await withFakeClient(async ({ adapter, state }) => {
    const result = await collect(adapter, options('form', [user('u1', 'ask which file to update')]))
    assertSucceeded(result)
    assert.deepEqual(state.formReplies, [{ id: 'provider_1', form: 'form_1', answer }])
    assert.equal(received.length, 1)
    assert.equal(received[0].harnessSessionId, 'form')
    assert.equal(received[0].providerSessionId, 'provider_1')
    assert.equal(received[0].event.data.form.id, 'form_1')
    assert.ok(visibleText(result).includes('The selected work is complete.'))
  }, {
    integration: { onForm: (context) => { received.push(context); return answer } },
    onPrompt: ({ id, emit }) => emit(undefined, 'form.created', {
      form: { id: 'form_1', sessionID: id, title: 'Choose a file', fields: [{ id: 'target', type: 'text', label: 'File' }] },
    }),
  })
})

for (const interaction of ['permission', 'form']) {
  await test(`an unhandled ${interaction} request fails with INTERACTION_REQUIRED and interrupts the agent`, { timeout: 2500 }, async () => {
    await withFakeClient(async ({ adapter, state }) => {
      const result = await collect(adapter, options(`unhandled-${interaction}`, [user('u1', 'perform interactive work')]))
      assert.equal(failureCode(result), 'INTERACTION_REQUIRED', 'an interactive wait must report the missing host integration')
      await nextTick()
      assert.deepEqual(state.interrupted, ['provider_1'])
      assert.equal(state.active.get('provider_1'), 0)
      assert.equal(state.permissionReplies.length + state.formReplies.length, 0)
    }, {
      timeoutMs: 100,
      onPrompt: ({ id, emit }) => interaction === 'permission'
        ? emit(id, 'permission.asked', { id: 'permission_1', action: 'shell', resource: 'npm run build' })
        : emit(undefined, 'form.created', { form: { id: 'form_1', sessionID: id, title: 'Question', fields: [] } }),
    })
  })
}

await test('rewritten text with the same history IDs creates a fresh provider conversation', { timeout: 2500 }, async () => {
  await withFakeClient(async ({ adapter, registry, state }) => {
    assertSucceeded(await collect(adapter, options('edited', [user('u1', 'original question')])))
    const previous = registry.providerSession('edited')
    assertSucceeded(await collect(adapter, options('edited', [user('u1', 'edited question'), user('u2', 'follow up')])))
    assert.notEqual(registry.providerSession('edited'), previous)
    assert.ok(state.deleted.includes(previous), 'the replaced provider conversation must be reclaimed')
    assert.ok(state.prompts[1].text.includes('edited question'))
    assert.ok(state.prompts[1].text.includes('follow up'))
    assert.ok(!state.prompts[1].text.includes('original question'))
  })
})

await test('an active registry turn survives reclamation past its grace window', { timeout: 2500 }, async () => {
  const registry = new SessionRegistry({ maxSessions: 2, idleTtlMs: 1, turnGraceMs: 1 })
  await registry.adopt('active', 'provider_active')
  const started = deferred()
  const complete = deferred()
  const running = registry.withEntry('active', async () => {
    started.resolve()
    await complete.promise
  })
  await started.promise
  try {
    assert.deepEqual(await registry.reclaim(Date.now() + 24 * 60 * 60_000), [])
    assert.equal(registry.providerSession('active'), 'provider_active')
  } finally {
    complete.resolve()
    await running
  }
})

await test('session-title requests use a temporary conversation and preserve the main mapping', { timeout: 2500 }, async () => {
  await withFakeClient(async ({ adapter, registry, state }) => {
    const history = [user('u1', 'main question')]
    const first = await collect(adapter, options('main', history))
    assertSucceeded(first)
    const main = registry.providerSession('main')
    const title = await collect(adapter, { ...options('main', [user('title-input', 'name this chat')]), purpose: 'session-title' })
    assertSucceeded(title)
    assert.equal(registry.providerSession('main'), main, 'the title request replaced the main session mapping')
    assert.notEqual(state.prompts[1].id, main)
    assert.ok(state.deleted.includes(state.prompts[1].id), 'auxiliary provider conversations must be reclaimed')
    assertSucceeded(await collect(adapter, options('main', [
      ...history, assistant('a1', visibleText(first)), user('u2', 'continue the main work'),
    ])))
    assert.equal(state.prompts[2].id, main)
    assert.ok(state.prompts[2].text.includes('continue the main work'))
    assert.ok(!state.prompts[2].text.includes('name this chat'))
  })
})
