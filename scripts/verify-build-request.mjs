// A build request must produce files.
//
// The failure this pins: the model was given the harness system prompt and a
// list of harness tool names, none of which it can call. Asked to build
// something it announced the plan, reasoned about which skill to load, and
// stopped in a few seconds having written nothing.
//
// The check sends a real build request through the adapter, with a harness-shaped
// prompt and tool list attached the way the harness attaches them, and requires
// that a file exists on disk when the turn ends.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeFreeAdapter, OpenCodeServerPool, ROUTE, refreshCatalog, OpenCodeClient } from '../lib/index.js'

const exe = `${process.env.APPDATA}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe`
const bin = existsSync(exe) ? exe : 'opencode'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const workspace = mkdtempSync(join(tmpdir(), 'deep-opencode-build-'))
const pool = new OpenCodeServerPool({ opencodeCommand: bin, host: '127.0.0.1', port: 0, startupTimeoutMs: 180000 })
const client = new OpenCodeClient(pool.forDirectory(undefined, workspace))
const adapter = new OpenCodeFreeAdapter(pool, workspace, () => undefined, 600000, 90000, undefined, true)

// Exactly the shape the harness sends: a system prompt describing its own tools,
// and a tool list naming them. Neither is callable from the provider's agent.
const HARNESS_SYSTEM = `You are the DeepSeek Harness assistant.
You can read, write and edit files, run shell commands, control a browser, and load skills.`
const HARNESS_TOOLS = ['read_file', 'write_file', 'edit_file', 'run_shell', 'browser_navigate', 'skill']

try {
  const models = await refreshCatalog(client, 120000)
  check('a free model is available', models.length > 0, `${models.length} model(s)`)
  const model = models.find((m) => m.id === 'big-pickle') ?? models[0]

  let text = ''
  let reasoning = ''
  const started = Date.now()
  for await (const chunk of adapter.stream({
    provider: ROUTE,
    model: model.id,
    sessionId: 'ses_build_request_test',
    system: HARNESS_SYSTEM,
    tools: HARNESS_TOOLS.map((name) => ({ name })),
    messages: [{
      role: 'user',
      id: 'u1',
      content: [{
        type: 'text',
        text: 'Create a file called hello.html in the current directory. It must contain the text ' +
          'BUILD_OK inside an <h1> tag. Create the file, do not describe it.',
      }],
    }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  const target = join(workspace, 'hello.html')
  const wrote = existsSync(target)
  check('the turn wrote a file', wrote, `${target} after ${seconds}s`)
  if (wrote) {
    const body = readFileSync(target, 'utf8')
    check('the file has the requested content', body.includes('BUILD_OK'), JSON.stringify(body.slice(0, 120)))
  }
  // The failure mode was a turn that reasons and stops. Reasoning with no file
  // is that failure, so the two are reported together.
  console.log(`      visible reply: ${JSON.stringify(text.trim().slice(0, 200))}`)
  console.log(`      reasoning seen: ${reasoning.length > 0 ? `${reasoning.length} chars` : 'none'}`)
} catch (error) {
  check('build request', false, error instanceof Error ? error.message : String(error))
} finally {
  await pool.stopAll()
  rmSync(workspace, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
