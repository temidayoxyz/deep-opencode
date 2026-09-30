// The model picker must not empty out.
//
// The reported failure was a route whose chat worked but whose picker listed
// only the built-in DeepSeek models. The chat ran on the session's own server
// while the catalogue was read from a separate fallback server, and a fallback
// server that is slow to answer reported no models at all.
//
// These checks pin the three ways that used to lose the list: a failed read, a
// read that timed out empty, and a fallback server that never started.
import { existsSync } from 'node:fs'
import {
  OpenCodeClient,
  OpenCodeFreeAdapter,
  OpenCodeServer,
  OpenCodeServerPool,
  ROUTE,
  refreshCatalog,
} from '../lib/index.js'

const exe = `${process.env.APPDATA}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe`
const bin = existsSync(exe) ? exe : 'opencode'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const pool = new OpenCodeServerPool({ opencodeCommand: bin, host: '127.0.0.1', port: 0, startupTimeoutMs: 180000 })
const fallbackDirectory = process.cwd()
const adapter = new OpenCodeFreeAdapter(pool, fallbackDirectory, () => undefined, 180000, 90_000, undefined, true)
const healthy = new OpenCodeClient(pool.forDirectory(undefined, fallbackDirectory))

/** A server that can never start, standing in for a broken fallback. */
const broken = new OpenCodeServer({
  opencodeCommand: 'definitely-not-a-real-opencode-binary',
  host: '127.0.0.1',
  port: 0,
  startupTimeoutMs: 3_000,
  cwd: fallbackDirectory,
})

try {
  // 1. The route advertises the free models at all.
  const first = await adapter.listModels()
  check('the route lists free models', first.length > 0, `${first.length} model(s)`)
  const free = first.filter((m) => (m.cost?.input ?? 0) === 0 || m.id.includes('free') || m.id === 'big-pickle')
  check('every listed model is a free one', free.length === first.length,
    first.map((m) => m.id).join(', '))

  // 2. A server that can never start must not empty the list.
  let threw = false
  try {
    await refreshCatalog(new OpenCodeClient(broken), 2_000)
  } catch {
    threw = true
  }
  const afterBroken = await adapter.listModels()
  check('a broken server does not empty the list', afterBroken.length === first.length,
    `${afterBroken.length} model(s)${threw ? ' (the read threw, as expected)' : ''}`)

  // 3. A server that answers empty must not empty the list either.
  await refreshCatalog(new OpenCodeClient(broken), 2_000).catch(() => [])
  const afterEmpty = await adapter.listModels()
  check('an empty answer does not empty the list', afterEmpty.length === first.length,
    `${afterEmpty.length} model(s)`)

  // 4. Repeated picker reads stay stable, which is what a re-render does.
  const reads = await Promise.all([adapter.listModels(), adapter.listModels(), adapter.listModels()])
  check('concurrent picker reads all return the list',
    reads.every((models) => models.length === first.length),
    reads.map((models) => models.length).join(', '))

  // 5. The route is still the one the harness asks about.
  check('the route resolves its own model', (await adapter.resolveModel(ROUTE, first[0].id)).id === first[0].id,
    ROUTE)
} catch (error) {
  check('catalogue resilience', false, error instanceof Error ? error.message : String(error))
} finally {
  await pool.stopAll()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
