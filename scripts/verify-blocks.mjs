// A turn that emits both reasoning and text must keep both.
//
// The provider numbers its reasoning and text blocks from zero independently, so
// passing its ordinal through as the harness block index made both blocks claim
// index 0: one replaced the other, and a turn's whole answer disappeared while
// its thinking stayed on screen. A live model reproduces this only sometimes, so
// this drives the translator with the exact event order instead.
import { translateEvents } from '../lib/index.js'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const assistantMessageID = 'msg_test'
const ev = (type, data) => ({ type, data: { assistantMessageID, ...data } })

// Both families number from zero: reasoning ordinal 0, then text ordinal 0.
const events = [
  ev('session.step.started', { model: { id: 'space-bunny-free', providerID: 'opencode' } }),
  ev('session.reasoning.started', { ordinal: 0 }),
  ev('session.reasoning.delta', { ordinal: 0, delta: 'The bat costs more, so the ball is cheaper.' }),
  ev('session.reasoning.ended', { ordinal: 0, text: 'The bat costs more, so the ball is cheaper.' }),
  ev('session.text.started', { ordinal: 0 }),
  ev('session.text.delta', { ordinal: 0, delta: '$0.01' }),
  ev('session.text.ended', { ordinal: 0, text: '$0.01' }),
  ev('session.step.ended', {
    finish: 'stop',
    tokens: { input: 100, output: 20, reasoning: 12, cache: { read: 5, write: 0 } },
  }),
  ev('session.execution.succeeded', {}),
]

const chunks = translateEvents(events)
const starts = chunks.filter((c) => c.type === 'block-start')
const ends = chunks.filter((c) => c.type === 'block-end')

console.log('      block-starts:', starts.map((c) => `${c.blockType}#${c.index}`).join(' '))
console.log('      block-ends  :', ends.map((c) => `${c.block.type}#${c.index}`).join(' '))

check('emitted both blocks', starts.length === 2, `${starts.length}`)
check('no two blocks share an index', new Set(starts.map((c) => c.index)).size === starts.length,
  starts.map((c) => c.index).join(','))
check('indexes follow first-seen order',
  starts.map((c) => c.index).every((v, i, all) => i === 0 || v > all[i - 1]),
  starts.map((c) => c.index).join(','))

const reasoningIndex = starts.find((c) => c.blockType === 'reasoning')?.index
const textIndex = starts.find((c) => c.blockType === 'text')?.index
check('reasoning and text are distinct blocks', reasoningIndex !== textIndex,
  `reasoning=${reasoningIndex} text=${textIndex}`)

const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta')
const textDeltas = chunks.filter((c) => c.type === 'text-delta')
check('reasoning deltas target the reasoning index',
  reasoningDeltas.every((c) => c.index === reasoningIndex), reasoningDeltas.map((c) => c.index).join(','))
check('text deltas target the text index',
  textDeltas.every((c) => c.index === textIndex), textDeltas.map((c) => c.index).join(','))

const textEnd = ends.find((c) => c.block.type === 'text')
check('the visible answer survives on its own block', textEnd?.block?.text === '$0.01', JSON.stringify(textEnd?.block?.text))
const reasoningEnd = ends.find((c) => c.block.type === 'reasoning')
check('the reasoning survives on its own block',
  (reasoningEnd?.block?.text ?? '').includes('cheaper'), JSON.stringify(reasoningEnd?.block?.text?.slice(0, 40)))

check('every started block ends', starts.length === ends.length, `${starts.length} / ${ends.length}`)

const types = chunks.map((c) => c.type)
const usageIndex = types.lastIndexOf('usage')
const finishIndex = types.lastIndexOf('finish')
check('usage precedes finish and nothing follows it',
  usageIndex !== -1 && finishIndex === types.length - 1 && usageIndex < finishIndex,
  types.join(' '))

// Text first, then reasoning: the first-seen order must reverse with the stream.
const reversed = translateEvents([
  ev('session.text.started', { ordinal: 0 }),
  ev('session.text.delta', { ordinal: 0, delta: 'answer' }),
  ev('session.text.ended', { ordinal: 0, text: 'answer' }),
  ev('session.reasoning.started', { ordinal: 0 }),
  ev('session.reasoning.delta', { ordinal: 0, delta: 'thinking' }),
  ev('session.reasoning.ended', { ordinal: 0, text: 'thinking' }),
  ev('session.step.ended', { finish: 'stop', tokens: { input: 1, output: 1 } }),
])
const reversedStarts = reversed.filter((c) => c.type === 'block-start')
check('indexes follow the stream, not the kind',
  reversedStarts[0]?.blockType === 'text' && reversedStarts[0]?.index === 0 &&
  reversedStarts[1]?.blockType === 'reasoning' && reversedStarts[1]?.index === 1,
  reversedStarts.map((c) => `${c.blockType}#${c.index}`).join(' '))

// Multiple provider steps belong to one Harness response and need distinct indexes.
const second = translateEvents([
  ev('session.text.started', { ordinal: 0 }),
  ev('session.text.delta', { ordinal: 0, delta: 'first' }),
  ev('session.text.ended', { ordinal: 0, text: 'first' }),
  { type: 'session.text.started', data: { assistantMessageID: 'msg_second', ordinal: 0 } },
  { type: 'session.text.delta', data: { assistantMessageID: 'msg_second', ordinal: 0, delta: 'second' } },
])
const secondStarts = second.filter((c) => c.type === 'block-start')
check('a new assistant message keeps distinct indexes within the delegated response',
  secondStarts.length === 2 && secondStarts[0].index === 0 && secondStarts[1].index === 1,
  secondStarts.map((c) => c.index).join(','))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
