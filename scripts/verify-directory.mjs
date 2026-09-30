// The delegated turn must run OpenCode's agent in the session's own project
// directory, not wherever the harness was launched.
//
// OpenCode fixes a session's project when its process starts and ignores a
// per-request directory, so this drives the real pool: two different session
// directories must each get their own server, each reporting its own cwd, and
// repeated requests for one directory must reuse the same server.
import { existsSync } from 'node:fs'
import { OpenCodeClient, OpenCodeServerPool, refreshCatalog } from '../lib/index.js'

const exe = `${process.env.APPDATA}\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe`
const bin = existsSync(exe) ? exe : 'opencode'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const config = { opencodeCommand: bin, host: '127.0.0.1', port: 0, startupTimeoutMs: 120000 }
const pool = new OpenCodeServerPool(config)
const fallback = 'C:\\Users\\Administrator'
const projectA = 'D:\\Codebase\\deep-opencode'
const projectB = 'D:\\Codebase\\deep-browser'

async function askCwd(server, label) {
  const client = new OpenCodeClient(server)
  // A cold server answers with an empty catalogue until it has fetched its
  // provider list, so the retrying discovery is used rather than a single read.
  const models = await refreshCatalog(client, 90000)
  const target = models.find((m) => m.id === 'space-bunny-free') ?? models[0]
  if (target === undefined) throw new Error(`${label}: no free model available`)
  const session = await client.createSession()
  await client.setModel(session, target.id, 'opencode')
  await client.prompt(session, 'What is your current working directory? Reply with only the absolute path and nothing else.')
  let text = ''
  const sub = new AbortController()
  const pump = (async () => {
    for await (const event of client.events(sub.signal)) {
      if (event.type === 'session.text.delta') text += event.data?.delta ?? ''
      if (event.type === 'session.execution.succeeded' || event.type === 'session.step.ended') break
    }
  })().catch(() => undefined)
  setTimeout(() => sub.abort(), 60000)
  await pump
  sub.abort()
  await client.deleteSession(session)
  return text.trim()
}

try {
  // Two directories must not share a server.
  const serverA = pool.forDirectory(projectA, fallback)
  const serverB = pool.forDirectory(projectB, fallback)
  check('different directories get different servers', serverA !== serverB)
  check('a repeated directory reuses its server', pool.forDirectory(projectA, fallback) === serverA)
  check('Windows paths match case-insensitively', pool.forDirectory(projectA.toUpperCase(), fallback) === serverA)

  // The fallback applies when a session has no usable directory.
  const serverFallback = pool.forDirectory(undefined, fallback)
  check('a missing directory falls back', serverFallback !== serverA)
  const serverMissing = pool.forDirectory('D:\\does\\not\\exist\\anywhere', fallback)
  check('an unusable directory falls back', serverMissing === serverFallback)

  check('pooled servers run in their directory',
    pool.directories.includes(projectA) && pool.directories.includes(projectB),
    pool.directories.join(' | '))

  // The decisive check: the agent reports the directory it was given.
  const inA = await askCwd(pool.forDirectory(projectA, fallback), 'A')
  check('the agent runs in the requested project', inA.toLowerCase().includes('deep-opencode'), JSON.stringify(inA))

  const inB = await askCwd(pool.forDirectory(projectB, fallback), 'B')
  check('a second project gets its own directory', inB.toLowerCase().includes('deep-browser'), JSON.stringify(inB))
} catch (error) {
  check('directory verification', false, error instanceof Error ? error.message : String(error))
} finally {
  await pool.stopAll()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)