// The cursor that decides what each turn sends.
//
// This is pure logic, so it is tested without a server: a wrong delta is a wrong
// conversation, and it must fail here rather than in a live turn.
import { SessionRegistry, digest, planTurn } from '../lib/index.js'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const m = (id, text) => ({ id, text })

// --- first turn: nothing sent yet, so everything goes, with the preamble ---
const history = [m('u1', 'first question'), m('a1', 'first answer'), m('u2', 'second question')]
const first = planTurn(history, undefined, false)
check('the first turn sends the whole conversation', first.messages.length === 3, `${first.messages.length}`)
check('the first turn carries the preamble', first.sendPreamble === true)
check('the first turn rebuilds the session', first.resendAll === true)

// --- second turn: only what follows the anchor ---
const second = planTurn([...history, m('a2', 'second answer'), m('u3', 'third question')], 'a2', true)
check('a follow-up sends only the delta', second.messages.length === 1 && second.messages[0].id === 'u3',
  second.messages.map((x) => x.id).join(','))
check('a follow-up does not repeat the preamble', second.sendPreamble === false)
check('a follow-up does not rebuild', second.resendAll === false)

// --- a repeated or retried turn has nothing new to send ---
const repeat = planTurn([...history, m('a2', 'second answer'), m('u3', 'third question')], 'u3', true)
check('a turn with nothing new sends nothing', repeat.messages.length === 0, `${repeat.messages.length}`)
check('a turn with nothing new does not rebuild', repeat.resendAll === false)

// --- divergence: the anchor was rewritten away ---
const diverged = planTurn([m('u9', 'compacted history'), m('u10', 'follow-up')], 'a2', true)
check('a rewritten prefix forces a full replay', diverged.resendAll === true)
check('a rewritten prefix replays everything', diverged.messages.length === 2, `${diverged.messages.length}`)

// --- empty messages are not sent as content ---
const withBlanks = planTurn([m('u1', 'a'), m('u2', ''), m('u3', 'c')], 'u1', true)
check('empty messages are skipped', withBlanks.messages.length === 1 && withBlanks.messages[0].id === 'u3',
  withBlanks.messages.map((x) => x.id).join(','))

// --- digest: only conversational roles, text only ---
const digested = digest({
  provider: 'opencode-free',
  model: 'space-bunny-free',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'ignored' }] },
    { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'hi' }] },
    { role: 'tool', id: 't1', content: [{ type: 'text', text: 'tool output' }] },
    { role: 'user', id: 'u2', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
  ],
})
check('the system role is not sent as conversation', digested.every((x) => x.text !== 'ignored'))
check('tool messages are not replayed as conversation', digested.every((x) => x.text !== 'tool output'),
  digested.map((x) => `${x.id}:${x.text}`).join(' '))
check('conversational roles are digested', digested.length === 3, digested.map((x) => x.id).join(','))
check('a message with no text digests to empty text',
  digested.find((x) => x.id === 'u2')?.text === '', JSON.stringify(digested.find((x) => x.id === 'u2')?.text))

// --- registry: adopt, advance, invalidate ---
const registry = new SessionRegistry({ maxSessions: 4, idleTtlMs: 0, turnGraceMs: 0 })
const sid = 'ses_test'

await registry.adopt(sid, 'oc_1')
check('a mapped provider session is reported', registry.providerSession(sid) === 'oc_1')
await registry.advance(sid, { messages: [m('u1', 'a')], sendPreamble: true, resendAll: true })
await registry.advance(sid, { messages: [m('u2', 'b')], sendPreamble: false, resendAll: false })
check('advancing keeps one entry', registry.size === 1)

await registry.invalidate(sid)
check('an invalidated session has no provider session', registry.providerSession(sid) === '')
check('an invalidated entry stays for the next turn', registry.size === 1)

// --- registry: concurrent turns are serialised ---
const order = []
const slow = new SessionRegistry()
const id1 = 'ses_a'
await Promise.all([
  slow.withEntry(id1, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 30)); order.push('a1-end') }),
  slow.withEntry(id1, async () => { order.push('a2'); order.push('a2-end') }),
])
check('concurrent turns do not interleave',
  JSON.stringify(order) === JSON.stringify(['a1', 'a1-end', 'a2', 'a2-end']), order.join(','))

// --- registry: a failing turn does not poison the queue ---
const resilient = new SessionRegistry()
const id2 = 'ses_b'
await resilient.withEntry(id2, async () => { throw new Error('boom') }).catch(() => undefined)
let ran = false
await resilient.withEntry(id2, async () => { ran = true })
check('a failed turn does not block the next', ran === true)

// --- registry: the count bound is enforced on adopt, not only on a sweep ---
const bounded = new SessionRegistry({ maxSessions: 2, idleTtlMs: 600_000, turnGraceMs: 60_000 })
await bounded.adopt('s1', 'oc_1')
await bounded.adopt('s2', 'oc_2')
const evicted = await bounded.adopt('s3', 'oc_3')
check('the count bound is enforced on adopt', bounded.size === 2, `${bounded.size}`)
check('the evicted provider session is returned for deletion', evicted.includes('oc_1'), evicted.join(','))
check('the newest session survives eviction', bounded.providerSession('s3') === 'oc_3')

// --- registry: a sweep reclaims by idle time without touching fresh entries ---
const swept = new SessionRegistry({ maxSessions: 8, idleTtlMs: 1000, turnGraceMs: 500 })
await swept.adopt('s1', 'oc_1')
check('a fresh entry survives a sweep', (await swept.reclaim()).length === 0)

// --- registry: idle reclamation respects the grace window ---
const idle = new SessionRegistry({ maxSessions: 8, idleTtlMs: 1000, turnGraceMs: 5000 })
await idle.adopt('s1', 'oc_1')
check('a fresh entry is not reclaimed', (await idle.reclaim()).length === 0)
check('an entry past the grace window is reclaimed', (await idle.reclaim(Date.now() + 10_000)).includes('oc_1'))

// --- registry: release and shutdown ---
const held = new SessionRegistry()
await held.adopt('s1', 'oc_1')
await held.adopt('s2', 'oc_2')
check('release returns the provider session', (await held.release('s1')) === 'oc_1')
check('a released session is gone', held.providerSession('s1') === undefined)
check('all lists the held sessions', held.all().includes('oc_2'), held.all().join(','))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)