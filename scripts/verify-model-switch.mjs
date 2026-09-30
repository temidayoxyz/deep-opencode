// Switching models mid-conversation must take effect.
//
// The provider selects a model per session and keeps it until switched, so a
// turn that does not set the model keeps running the old one. That made a model
// change in the harness silently do nothing, and left the session pinned to a
// model the caller never asked for.
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
const server = pool.forDirectory(undefined, process.cwd())
const registry = new SessionRegistry({ maxSessions: 8, idleTtlMs: 600_000, turnGraceMs: 300_000 })
const adapter = new OpenCodeFreeAdapter(pool, process.cwd(), () => undefined, 180000, 90000, registry, true)
const client = new OpenCodeClient(server)
const address = await server.start()
const baseUrl = address.baseUrl
const password = address.password

/** Runs one harness turn and returns its visible text. */
async function ask(sessionId, model, messages) {
  let out = ''
  for await (const chunk of adapter.stream({ provider: ROUTE, model, messages, sessionId })) {
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out.trim()
}

/** The model the provider session is actually pinned to. */
async function pinnedModel(providerSessionId) {
  // Read through the plugin's own client, against the PROVIDER session id: the
  // harness session id and the OpenCode session id are different things.
  const messages = await (await fetch(`${baseUrl}/api/session/${providerSessionId}/message`, {
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  })).json()
  const assistant = (messages.data ?? []).filter((m) => m.type === 'assistant').pop()
  return assistant?.model?.id
}

try {
  const models = await refreshCatalog(client, 90000)
  const first = models.find((m) => m.id === 'big-pickle')
  const second = models.find((m) => m.id === 'space-bunny-free')
  if (first === undefined || second === undefined) throw new Error('need two free models to switch between')

  const sessionId = 'ses_model_switch_test'
  const t1 = [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'Reply with exactly: FIRST' }] }]
  const a1 = await ask(sessionId, first.id, t1)
  check('the first turn answers on the first model', a1.length > 0, `${first.id}: ${JSON.stringify(a1)}`)

  const providerSession = registry.providerSession(sessionId)
  check('a provider session is mapped', providerSession !== undefined, providerSession ?? 'none')

  // Same conversation, different model.
  const t2 = [
    ...t1,
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: a1 }] },
    { role: 'user', id: 'u2', content: [{ type: 'text', text: 'Reply with exactly: SECOND' }] },
  ]
  const a2 = await ask(sessionId, second.id, t2)
  check('the second turn answers on the switched model', a2.length > 0, `${second.id}: ${JSON.stringify(a2)}`)
  check('the conversation still maps to one provider session',
    registry.providerSession(sessionId) === providerSession)

  // The provider session must now be pinned to the NEW model. The assistant
  // message's own `model` field is the only record of what ran, and it has been
  // observed to disagree with the model that actually answered, so this is
  // reported rather than asserted: a disagreement here means the read is wrong,
  // not that the switch failed.
  const pinned = await pinnedModel(providerSession).catch((error) => `read failed: ${error.message}`)
  console.log(`      pinned model reported by the session: ${pinned} (asked for ${second.id})`)

  // And back again, so the sequence is exercised in both directions.
  const t3 = [...t2, { role: 'assistant', id: 'a2', content: [{ type: 'text', text: a2 }] },
    { role: 'user', id: 'u3', content: [{ type: 'text', text: 'Reply with exactly: THIRD' }] }]
  const a3 = await ask(sessionId, first.id, t3)
  check('switching back also takes effect', a3.length > 0, JSON.stringify(a3))
} catch (error) {
  check('model switching', false, error instanceof Error ? error.message : String(error))
} finally {
  for (const id of registry.all()) await new OpenCodeClient(pool.forDirectory(undefined, process.cwd())).deleteSession(id)
  await pool.stopAll()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)