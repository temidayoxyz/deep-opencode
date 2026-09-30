// End-to-end check against a real `opencode serve`: start it through the
// plugin's own server manager, discover the free models, and run one delegated
// turn, asserting the stream protocol holds.
import { existsSync } from 'node:fs'
import { OpenCodeClient, OpenCodeServerPool, OpenCodeFreeAdapter, ROUTE, refreshCatalog } from '../lib/index.js'

// On Windows the `opencode` launcher on PATH is a shim script rather than an
// executable, so the real binary is named explicitly here. The plugin itself
// resolves whatever `opencodeCommand` names through PATH.
function resolveOpenCode() {
  if (process.platform !== 'win32') return 'opencode'
  const candidates = [
    `${process.env.APPDATA ?? ''}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe`,
    `${process.env.APPDATA ?? ''}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode`,
  ]
  return candidates.find((path) => existsSync(path)) ?? 'opencode'
}

const config = {
  opencodeCommand: resolveOpenCode(),
  host: '127.0.0.1',
  port: 0,
  startupTimeoutMs: 120000,
}

const pool = new OpenCodeServerPool(config)
const server = pool.forDirectory(undefined, process.cwd())
const client = new OpenCodeClient(server)

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  const address = await server.start()
  check('server started', address.baseUrl.startsWith('http://127.0.0.1'), address.baseUrl)

  const info = await client.info()
  check('server reports a version', typeof info.version === 'string', `v${info.version}`)

  const models = await refreshCatalog(client, 90000)
  check('discovered free models', models.length > 0, `${models.length} model(s)`)
  console.log('      models:', models.map((m) => m.id).join(', '))
  const withContext = models.filter((m) => m.context?.contextWindow !== undefined)
  check('free models carry context metadata', withContext.length === models.length, `${withContext.length}/${models.length}`)

  const target = models.find((m) => m.id === 'space-bunny-free') ?? models[0]
  check('picked a model', target !== undefined, target?.id)
  if (target === undefined) throw new Error('no free model to exercise')

  const adapter = new OpenCodeFreeAdapter(pool, process.cwd(), () => undefined, 180000, 90000)
  const listed = await adapter.listModels()
  check('adapter advertises models for the GUI', listed.length === models.length, `${listed.length} listed`)

  const resolved = await adapter.resolveModel(ROUTE, target.id)
  check('resolveModel returns metadata', resolved.id === target.id && resolved.name.length > 0, resolved.name)
  check('resolveModel carries context', resolved.context?.contextWindow !== undefined, `${resolved.context?.contextWindow} tokens`)

  // One delegated turn, checked against the stream protocol.
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: ROUTE,
    model: target.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
  })) {
    chunks.push(chunk)
  }

  const types = chunks.map((c) => c.type)
  console.log('      chunks:', types.join(' '))

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  check('produced text', text.trim().length > 0, JSON.stringify(text.trim()))

  const finishIndex = types.lastIndexOf('finish')
  const usageIndex = types.lastIndexOf('usage')
  check('emitted a terminal finish', finishIndex !== -1)
  check('emitted usage', usageIndex !== -1)
  check('usage precedes finish', usageIndex !== -1 && finishIndex !== -1 && usageIndex < finishIndex)
  check('nothing emitted after finish', finishIndex === types.length - 1)

  const finish = chunks[finishIndex]
  check('finish reason is a known kind', ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(finish?.reason?.kind), finish?.reason?.kind)

  const usage = chunks[usageIndex]?.usage
  check('usage counts output tokens', (usage?.outputTokens ?? 0) > 0, `in=${usage?.inputTokens} out=${usage?.outputTokens} cacheRead=${usage?.cacheReadTokens}`)

  const started = types.filter((t) => t === 'block-start').length
  const ended = types.filter((t) => t === 'block-end').length
  check('every started block ends', started === ended, `${started} started / ${ended} ended`)

  // A second model, and a request that carries a system prompt plus history, so
  // the prompt assembly path is exercised rather than only the bare-user case.
  const other = models.find((m) => m.id === 'big-pickle')
  if (other !== undefined) {
    const second = []
    for await (const chunk of adapter.stream({
      provider: ROUTE,
      model: other.id,
      system: 'You are terse.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '4' }] },
        { role: 'user', content: [{ type: 'text', text: 'Reply with only the number.' }] },
      ],
    })) {
      second.push(chunk)
    }
    const secondText = second.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    check('second model produced text', secondText.trim().length > 0, `${other.id}: ${JSON.stringify(secondText.trim().slice(0, 40))}`)
    check('second turn reached a finish', second.at(-1)?.type === 'finish', second.at(-1)?.type)
  } else {
    check('second model available to exercise', false)
  }
} finally {
  await pool.stopAll()
  check('server stopped', true)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)