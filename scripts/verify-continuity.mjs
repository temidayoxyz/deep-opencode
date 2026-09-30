// Reusing ONE OpenCode session across turns must give real conversational
// continuity, and must need only the new message each turn.
//
// The current design creates and deletes a session per request and replays the
// whole history as flattened text, so the model could not recall an earlier turn
// and every turn re-sent the transcript. This is the check that fails under that
// design and must pass under session reuse.
import { existsSync } from 'node:fs'
import { OpenCodeClient, OpenCodeServerPool, refreshCatalog } from '../lib/index.js'

const exe = `${process.env.APPDATA}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe`
const bin = existsSync(exe) ? exe : 'opencode'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const pool = new OpenCodeServerPool({ opencodeCommand: bin, host: '127.0.0.1', port: 0, startupTimeoutMs: 120000 })
const client = new OpenCodeClient(pool.forDirectory(undefined, process.cwd()))

/** Sends one turn into an existing session and collects the visible text. */
async function turn(sessionId, text, seconds = 60) {
  const sub = new AbortController()
  let out = ''
  const pump = (async () => {
    for await (const event of client.events(sub.signal)) {
      if (event.type === 'session.text.delta') out += event.data?.delta ?? ''
      if (event.type === 'session.step.ended' || event.type === 'session.execution.failed') break
    }
  })().catch(() => undefined)
  await client.prompt(sessionId, text)
  setTimeout(() => sub.abort(), seconds * 1000)
  await pump
  sub.abort()
  return out.trim()
}

try {
  const models = await refreshCatalog(client, 90000)
  const target = models.find((m) => m.id === 'space-bunny-free') ?? models[0]
  if (target === undefined) throw new Error('no free model available')

  const session = await client.createSession()
  await client.setModel(session, target.id, 'opencode')

  const first = await turn(session, 'Remember this exact codeword: PLATYPUS. Reply with only: saved')
  check('first turn answers', first.length > 0, JSON.stringify(first))

  const recalled = await turn(session, 'What codeword did I ask you to remember earlier in this conversation? Reply with only the codeword.')
  check('a later turn recalls an earlier one', recalled.toUpperCase().includes('PLATYPUS'), JSON.stringify(recalled))

  // PLATYPUS is eight letters; asking for letters+1 proves the answer came from
  // turn 2 rather than being a lucky guess at turn 1.
  const derived = await turn(session, 'Reply with only the number: letters in that codeword, plus one.')
  check('a third turn builds on the second', /^9\b/.test(derived.trim()), JSON.stringify(derived))

  await client.deleteSession(session)
} catch (error) {
  check('continuity', false, error instanceof Error ? error.message : String(error))
} finally {
  await pool.stopAll()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)