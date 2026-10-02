// A complete delegated agent workflow: build three files, then revise them in
// the same provider session. Requires a real OpenCode install and free model.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { OpenCodeClient, OpenCodeFreeAdapter, OpenCodeServerPool, SessionRegistry, refreshCatalog } from '../lib/index.js'

const executable = join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe')
const pool = new OpenCodeServerPool({ opencodeCommand: existsSync(executable) ? executable : 'opencode', host: '127.0.0.1', port: 0, startupTimeoutMs: 120_000 })
const temporaryRoot = resolve(tmpdir())
const workspace = resolve(mkdtempSync(join(temporaryRoot, 'deep-opencode-agent-')))
const registry = new SessionRegistry()
const events = new Map()
const started = Date.now()
const report = setInterval(() => console.log(`PROGRESS ${Math.round((Date.now() - started) / 1000)}s files=${readdirSync(workspace).join(',')} tools=${events.get('session.tool.success') ?? 0}`), 10_000)
const adapter = new OpenCodeFreeAdapter(pool, workspace, () => workspace, 600_000, 60_000, registry, true, false, {
  onEvent: ({ event }) => {
    events.set(event.type, (events.get(event.type) ?? 0) + 1)
    if (event.type === 'session.tool.called') console.log(`TOOL ${event.data?.name ?? event.data?.id ?? 'called'}`)
    if (event.type === 'session.tool.failed') console.log('TOOL FAILED', JSON.stringify(event.data?.error))
    if (event.type === 'session.step.ended') console.log(`STEP ${event.data?.finish ?? 'ended'}`)
  },
  onPermission: ({ event }) => {
    const request = event.data?.request ?? event.data
    const resources = request?.resources ?? []
    // The test owns only these generated files. Deny unrelated actions and
    // shell commands; the build prompt needs only native file operations.
    const fileAction = /(?:read|write|edit|filesystem)/i.test(request?.action ?? '') && !/shell|execute/i.test(request?.action ?? '')
    const inside = resources.length > 0 && resources.every((resource) => {
      const path = relative(workspace, resolve(workspace, resource))
      return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !resolve(workspace, resource).startsWith('\\\\')
    })
    const decision = fileAction && inside ? 'once' : 'reject'
    console.log(`PERMISSION ${request?.action ?? 'unknown'} ${decision}`)
    return decision
  },
})
const client = new OpenCodeClient(pool.forDirectory(undefined, workspace))
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] })

async function ask(model, messages) {
  let text = ''
  let finish
  let usage
  for await (const chunk of adapter.stream({ provider: 'opencode-free', model, sessionId: 'ses_agent_workflow', messages,
    system: 'You are the DeepSeek Harness assistant.', tools: [{ name: 'write_file', parameters: {}, description: 'Write a file' }] })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  assert.equal(finish?.kind, 'stop', JSON.stringify(finish))
  assert.ok(usage && usage.inputTokens > 0, 'the whole agent execution must report usage')
  return text
}

try {
  const models = await refreshCatalog(client)
  const selected = process.env.OPENCODE_TEST_MODEL
  const model = selected === undefined
    ? models.find((entry) => /lightning/i.test(entry.id)) ?? models.find((entry) => entry.id === 'big-pickle') ?? models[0]
    : models.find((entry) => entry.id === selected)
  assert.ok(model, 'no free model discovered')
  console.log(`MODEL ${model.id}`)
  const messages = [user('u1', 'Create a complete landing page for Mimo in the current directory with exactly eight <section> elements. Write index.html, styles.css, and script.js. Link the CSS and JavaScript files from the HTML. Use plain HTML CSS JS and implement a working mobile navigation toggle. Do not install dependencies, start a server, browse, or run shell commands. Stop as soon as the three files have been written; briefly report completion.')]
  const first = await ask(model.id, messages)
  for (const name of ['index.html', 'styles.css', 'script.js']) assert.ok(existsSync(join(workspace, name)), `${name} must exist when the turn completes`)
  const html = readFileSync(join(workspace, 'index.html'), 'utf8')
  assert.equal((html.match(/<section\b/gi) ?? []).length, 8)
  assert.ok(html.includes('styles.css') && html.includes('script.js'))
  const provider = registry.providerSession('ses_agent_workflow')
  messages.push({ id: 'a1', role: 'assistant', content: [{ type: 'text', text: first }] },
    user('u2', 'Now read index.html and change the main heading to exactly MIMO_WORKFLOW_OK. Keep all eight sections and both linked files. Make the edit using file tools, then stop and report completion. Do not browse or run shell commands.'))
  await ask(model.id, messages)
  assert.equal(registry.providerSession('ses_agent_workflow'), provider, 'follow-up must reuse the provider session')
  assert.ok(readFileSync(join(workspace, 'index.html'), 'utf8').includes('MIMO_WORKFLOW_OK'))
  assert.ok((events.get('session.tool.called') ?? 0) > 0, 'the delegated agent must actually use its tools')
  console.log('PASS full build, tool execution, follow-up edit, session continuity, token usage')
  console.log('EVENTS', Object.fromEntries(events))
} finally {
  clearInterval(report)
  await adapter.dispose()
  await registry.deleteSessions(registry.drain())
  await pool.stopAll()
  const withinTemporaryRoot = relative(temporaryRoot, workspace)
  if (withinTemporaryRoot.startsWith('..') || resolve(temporaryRoot, withinTemporaryRoot) !== workspace || !withinTemporaryRoot.startsWith('deep-opencode-agent-')) {
    throw new Error(`Refusing to remove unexpected test directory: ${workspace}`)
  }
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.warn(`Test workspace retained at ${workspace}: ${error.message}`)
  }
}
