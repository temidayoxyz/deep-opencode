// Real filesystem checks for the private companion copy used by OpenCode.
// Fixtures stay on the workspace drive, including when the system drive is full.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OpenCodeCompanion } from '../lib/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const initialSource = "export default 'initial companion';\n"

async function withFixture(run) {
  const fixture = await mkdtemp(join(root, '.companion-verification-'))
  const source = join(fixture, 'installed-plugin')
  const parent = join(fixture, 'runtime')
  const companion = new OpenCodeCompanion(source, parent)
  try {
    await mkdir(source)
    await mkdir(parent)
    await writeFile(join(source, 'index.js'), initialSource)
    // The staged companion must declare ESM even in a CommonJS parent scope.
    await writeFile(join(parent, 'package.json'), '{"type":"commonjs"}\n')
    await run({ fixture, source, parent, companion })
  } finally {
    try { await companion.dispose() } finally {
      const location = relative(root, fixture)
      assert.ok(location.startsWith('.companion-verification-') && resolve(root, location) === fixture)
      await rm(fixture, { recursive: true, force: true })
    }
  }
}

const stagedDirectories = async (parent) => (await readdir(parent))
  .filter((name) => name.startsWith('deep-opencode-companion-'))

test('concurrent requests reuse a private ESM copy independent of the installed plugin', async () => {
  await withFixture(async ({ fixture, source, parent, companion }) => {
    const first = companion.directory()
    assert.equal(companion.directory(), first, 'concurrent staging must share one promise')
    const directory = await first
    assert.equal(await companion.directory(), directory)
    assert.equal((await stagedDirectories(parent)).length, 1)
    assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).type, 'module')
    assert.equal((await import(pathToFileURL(join(directory, 'index.js')).href)).default, 'initial companion')

    await writeFile(join(source, 'index.js'), "export default 'updated companion';\n")
    await rename(source, join(fixture, 'replaced-plugin'))
    assert.equal(await readFile(join(directory, 'index.js'), 'utf8'), initialSource)
    assert.equal(await companion.directory(), directory, 'package replacement must not move the runtime copy')

    await companion.dispose()
    assert.deepEqual(await stagedDirectories(parent), [])
  })
})

test('disposal during staging waits for creation and removes the completed copy', async () => {
  await withFixture(async ({ parent, companion }) => {
    const creating = companion.directory()
    const disposing = companion.dispose()
    assert.equal(companion.dispose(), disposing, 'repeated disposal must share cleanup')
    await creating
    await disposing
    assert.deepEqual(await stagedDirectories(parent), [], 'staging in flight must not leave a runtime directory')
    await assert.rejects(companion.directory(), /disposed/)
  })
})

test('failed copy leaves no runtime directory and can retry after the source is repaired', async () => {
  await withFixture(async ({ source, parent, companion }) => {
    await rm(join(source, 'index.js'))
    await assert.rejects(companion.directory(), { code: 'ENOENT' })
    assert.deepEqual(await stagedDirectories(parent), [])

    await writeFile(join(source, 'index.js'), initialSource)
    const directory = await companion.directory()
    assert.equal(await readFile(join(directory, 'index.js'), 'utf8'), initialSource)
    assert.equal((await stagedDirectories(parent)).length, 1)
    await companion.dispose()
    assert.deepEqual(await stagedDirectories(parent), [])
  })
})

test('disposing before first use prevents allocation', async () => {
  await withFixture(async ({ parent, companion }) => {
    await companion.dispose()
    await assert.rejects(companion.directory(), /disposed/)
    assert.deepEqual(await stagedDirectories(parent), [])
  })
})
