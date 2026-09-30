// Through the real adapter, one harness session must keep its conversation.
//
// This is the end-to-end form of the continuity requirement: two turns on one
// harness session, each sending only its delta, and the second must recall what
// the first said. It fails if the adapter still creates a provider session per
// request or if the cursor sends the whole transcript each time.
import { existsSync } from 'node:fs'
import {
  OpenCodeClient,
  OpenCodeFreeAdapter,
  OpenCodeServerPool,
  ROUTE,
  SessionRegistry,
  refreshCatalog,
} from '../lib/index.js'

const exe = `${process.env.APPDATA}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe`
const bin = existsSync(exe) ? exe : 'opencode'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const pool = new OpenCodeServerPool({ opencodeCommand: bin, host: '127.0.0.1', port: 0, startupTimeoutMs: 120000 })
const registry = new SessionRegistry({ maxSessions: 8, idleTtlMs: 600_000, turnGraceMs: 300_000 })
const adapter = new OpenCodeFreeAdapter(pool, process.cwd(), () => undefined, 180000, 90000, registry, true)

/** Runs one harness turn and returns its visible text. */
async function ask(sessionId, messages) {
  let out = ''
  for await (const chunk of adapter.stream({ provider: ROUTE, model: 'space-bunny-free', messages, sessionId })) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out.trim()
}

try {
  const client = new OpenCodeClient(pool.forDirectory(undefined, process.cwd()))
  const models = await refreshCatalog(client, 90000)
  if (models.length === 0) throw new Error('no free model available')
  const target = models.find((m) => m.id === 'space-bunny-free') ?? models[0]

  // One harness session, two turns, each carrying the growing conversation.
  const sessionId = 'ses_continuity_test'
  const turn1 = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'Remember this exact codeword: PLATYPUS. Reply with only: saved' }] }]
  const first = await ask(sessionId, turn1)
  check('the first turn answers', first.length > 0, JSON.stringify(first))

  const providerSession = registry.providerSession(sessionId)
  check('the turn left a mapped provider session', providerSession !== undefined, providerSession ?? 'none')

  const turn2 = [
    ...turn1,
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: first }] },
    { role: 'user', id: 'u2', content: [{ type: 'text', text: 'What codeword did I ask you to remember earlier? Reply with only the codeword.' }] },
  ]
  const second = await ask(sessionId, turn2)
  check('the second turn recalls the first', second.toUpperCase().includes('PLATYPUS'), JSON.stringify(second))

  check('the same provider session was reused',
    registry.providerSession(sessionId) === providerSession,
    `${providerSession} -> ${registry.providerSession(sessionId)}`)

  // A different harness session must not see the first conversation.
  const otherSession = 'ses_isolation_test'
  const third = await ask(otherSession, [
    { role: 'user', id: 'u3', content: [{ type: 'text', text: 'What codeword did I ask you to remember earlier? If none was mentioned, reply exactly: NONE' }] },
  ])
  check('a separate harness session does not inherit the conversation',
    !third.toUpperCase().includes('PLATYPUS'), JSON.stringify(third))

  check('two harness sessions are mapped separately',
    registry.providerSession(otherSession) !== providerSession)
  void target
} catch (error) {
  check('adapter continuity', false, error instanceof Error ? error.message : String(error))
} finally {
  for (const id of registry.all()) await new OpenCodeClient(pool.forDirectory(undefined, process.cwd())).deleteSession(id)
  await pool.stopAll()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)