import assert from 'node:assert/strict'
import test from 'node:test'
import { clearCatalog, listModels, refreshCatalog } from '../lib/index.js'

await test('an old discovery read cannot restore a catalogue after unload', async () => {
  let resolve
  const read = new Promise((done) => { resolve = done })
  const pending = refreshCatalog({ listModels: () => read }, 100)
  clearCatalog()
  resolve([{ id: 'fixture-free', providerID: 'opencode', cost: [{ input: 0, output: 0 }] }])
  await pending
  assert.deepEqual(listModels(), [])
})

await test('discovery from the current generation still fills the catalogue', async () => {
  clearCatalog()
  await refreshCatalog({ listModels: async () => [{ id: 'new-free', providerID: 'opencode', cost: [{ input: 0, output: 0 }] }] }, 100)
  assert.equal(listModels()[0].id, 'new-free')
  clearCatalog()
})
