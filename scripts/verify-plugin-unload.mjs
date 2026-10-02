// Exercise the exported plugin through Cordis: package replacement must wait
// for its managed processes and listener to finish shutting down.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const nextTick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function withPlugin(run, { failStop = false, failBridge = false } = {}) {
  const events = []
  const gates = { adapter: deferred(), servers: deferred(), bridge: deferred(), companion: deferred() }
  const replacements = [
    [plugin.OpenCodeClient.prototype, 'listModels', async () => [{
      providerID: 'opencode', id: 'fixture-free', cost: [{ input: 0, output: 0 }],
    }]],
    [plugin.OpenCodeFreeAdapter.prototype, 'dispose', async () => {
      events.push('adapter:start')
      await gates.adapter.promise
      events.push('adapter:end')
    }],
    [plugin.OpenCodeServerPool.prototype, 'stopAll', async () => {
      events.push('servers:start')
      await gates.servers.promise
      events.push('servers:end')
      if (failStop) throw new Error('fixture server shutdown failure')
    }],
    [plugin.HarnessToolBridge.prototype, 'dispose', async () => {
      events.push('bridge:start')
      await gates.bridge.promise
      events.push('bridge:end')
      if (failBridge) throw new Error('fixture bridge shutdown failure')
    }],
    [plugin.OpenCodeCompanion.prototype, 'dispose', async () => {
      events.push('companion:start')
      await gates.companion.promise
      events.push('companion:end')
    }],
  ]
  const originals = replacements.map(([target, name]) => target[name])
  const ctx = new Context()
  let fiber
  let disposing
  try {
    for (const [target, name, replacement] of replacements) target[name] = replacement
    ctx.provide('llm', { registerAdapter: (routes, adapter) => {
      assert.deepEqual(routes, ['opencode-free'])
      assert.ok(adapter instanceof plugin.OpenCodeFreeAdapter)
      events.push('register')
      return () => events.push('unregister')
    } })
    ctx.provide('sessions', { get: () => undefined })
    fiber = await ctx.plugin(plugin, {
      logDiagnostics: false, bridgeHarnessTools: false,
      catalogTimeoutMs: 0, sessionIdleTtlMs: 0,
    })
    // Let the catalogue warm-up complete before unloading the plugin.
    await nextTick()
    assert.deepEqual(events, ['register'])
    let finished = false
    disposing = fiber.dispose().then(() => { finished = true })
    await run({ events, gates, disposing, finished: () => finished })
  } finally {
    // Even a failing assertion must release pending cleanup before restoring
    // the process-boundary stubs or exiting the test runner.
    for (const gate of Object.values(gates)) gate.resolve()
    try {
      await disposing
      await nextTick()
      await fiber?.dispose()
      await ctx.fiber.dispose()
    } finally {
      replacements.forEach(([target, name], index) => { target[name] = originals[index] })
      plugin.clearCatalog()
    }
  }
}

test('Cordis unload waits for adapter, managed servers, tool bridge, and runtime copy', async () => {
  await withPlugin(async ({ events, gates, disposing, finished }) => {
    await nextTick()
    assert.ok(events.includes('adapter:start'))
    assert.equal(finished(), false, 'plugin unload must wait for active turns to drain')

    gates.adapter.resolve()
    await nextTick()
    assert.ok(events.includes('servers:start'))
    assert.equal(finished(), false, 'plugin unload must wait for managed processes to exit')

    gates.servers.resolve()
    await nextTick()
    assert.ok(events.includes('bridge:start'))
    assert.equal(finished(), false, 'plugin unload must wait for the bridge listener to close')

    gates.bridge.resolve()
    await nextTick()
    assert.ok(events.includes('companion:start'))
    assert.equal(finished(), false, 'plugin unload must wait for runtime files to be removed')

    gates.companion.resolve()
    await disposing
    assert.deepEqual(events.filter((event) => event !== 'unregister'), [
      'register', 'adapter:start', 'adapter:end', 'servers:start',
      'servers:end', 'bridge:start', 'bridge:end', 'companion:start', 'companion:end',
    ])
    assert.equal(events.filter((event) => event === 'unregister').length, 1)
  })
})

test('a managed server shutdown failure still closes the tool bridge before unloading', async () => {
  await withPlugin(async ({ events, gates, disposing, finished }) => {
    gates.adapter.resolve()
    gates.servers.resolve()
    gates.companion.resolve()
    await nextTick()
    assert.ok(events.includes('bridge:start'))
    assert.equal(finished(), false, 'failed server shutdown must still await listener cleanup')
    gates.bridge.resolve()
    await disposing
    assert.ok(events.includes('bridge:end'))
    assert.ok(events.includes('unregister'))
  }, { failStop: true })
})

test('a tool bridge shutdown failure still removes the runtime copy before unloading', async () => {
  await withPlugin(async ({ events, gates, disposing, finished }) => {
    gates.adapter.resolve()
    gates.servers.resolve()
    gates.bridge.resolve()
    await nextTick()
    assert.ok(events.includes('companion:start'))
    assert.equal(finished(), false, 'failed bridge shutdown must still await runtime cleanup')
    gates.companion.resolve()
    await disposing
    assert.ok(events.includes('companion:end'))
    assert.ok(events.includes('unregister'))
  }, { failBridge: true })
})
