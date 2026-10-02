// Guards the model metadata the harness validates before it will advertise a
// route: every advertised model must name this plugin's own route, must be
// unique, and must carry a name and a context window.
//
// This class of bug passes typecheck, because the harness types `provider` as a
// plain string. It only fails at load, with "adapter returned invalid or
// duplicate model metadata", so it needs an explicit assertion.
import { OPENCODE_FREE_ROUTE, isFreeModel, toFreeModel } from '../lib/index.js'

const entries = [
  {
    id: 'space-bunny-free',
    providerID: 'opencode',
    name: 'Space Bunny Free',
    capabilities: { tools: true, input: ['text', 'image', 'video'], output: ['text'] },
    limit: { context: 1048576, input: 524288, output: 524288 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  },
  {
    id: 'big-pickle',
    providerID: 'opencode',
    name: 'Big Pickle',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    limit: { context: 200000, output: 32000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  },
  // A paid model and a non-opencode model must both be excluded.
  { id: 'gpt-5.5', providerID: 'opencode', cost: [{ input: 2, output: 10 }] },
  { id: 'some-other-free', providerID: 'groq', cost: [{ input: 0, output: 0 }] },
  // An entry with no cost is unknown, not free, and must not be offered.
  { id: 'unknown-cost', providerID: 'opencode' },
  { id: 'paid-output', providerID: 'opencode', cost: [{ input: 0, output: 1 }] },
  { id: 'paid-cache', providerID: 'opencode', cost: [{ input: 0, output: 0, cache: { write: 1 } }] },
  { id: 'paid-tier', providerID: 'opencode', cost: [{ input: 0, output: 0 }, { input: 1, output: 1 }] },
]

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

check('free filter accepts only opencode free models',
  entries.filter(isFreeModel).map((e) => e.id).join(',') === 'space-bunny-free,big-pickle',
  entries.filter(isFreeModel).map((e) => e.id).join(','))

const models = entries.filter(isFreeModel).map(toFreeModel)

check('advertised models name this plugin\'s route, not OpenCode\'s provider id',
  models.every((m) => m.provider === OPENCODE_FREE_ROUTE),
  models.map((m) => `${m.id}=${m.provider}`).join(' '))

check('no duplicate model ids', new Set(models.map((m) => m.id)).size === models.length,
  `${models.length} models, ${new Set(models.map((m) => m.id)).size} unique`)

check('every model has a display name', models.every((m) => m.name.length > 0))

check('every model has a positive context window',
  models.every((m) => (m.context?.contextWindow ?? 0) > 0),
  models.map((m) => `${m.id}=${m.context?.contextWindow}`).join(' '))

check('modalities advertise only text, which the delegated route forwards',
  models.every((m) => JSON.stringify(m.inputModalities) === '["text"]'),
  JSON.stringify(models.map((m) => m.inputModalities)))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
