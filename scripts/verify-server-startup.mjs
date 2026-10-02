// Disposal must settle pending startup before plugin runtime files are removed.
// Gating environment preparation keeps these tests independent of processes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCodeServer, OpenCodeServerPool } from '../lib/index.js'

const nextTick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const config = { opencodeCommand: process.execPath, host: '127.0.0.1', port: 0, startupTimeoutMs: 1000 }

for (const pooled of [false, true]) {
  test(`${pooled ? 'pool' : 'server'} disposal waits for pending environment preparation`, async () => {
    const entered = deferred()
    const gate = deferred()
    const prepare = async () => { entered.resolve(); await gate.promise; return {} }
    const owner = pooled ? new OpenCodeServerPool(config, prepare) : new OpenCodeServer(config, prepare)
    const server = pooled ? owner.forDirectory(undefined, process.cwd()) : owner
    let disposing
    let finished = false
    // Observe the expected rejection immediately to avoid unhandled rejections.
    const starting = assert.rejects(server.start(), /stopped during environment preparation/)
    try {
      await entered.promise
      disposing = (pooled ? owner.stopAll() : owner.dispose()).then(() => { finished = true })
      await nextTick()
      assert.equal(finished, false, 'unload must not complete while startup still uses runtime resources')
      gate.resolve()
      await disposing
      await starting
      await assert.rejects(server.start(), /disposed/)
    } finally {
      gate.resolve()
      await starting
      await disposing
      await (pooled ? owner.stopAll() : owner.dispose())
    }
  })
}
