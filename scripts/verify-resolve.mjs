// Does the plugin spawn OpenCode from the bare name `opencode`, the same value
// the default config carries? On Windows that resolves to a PowerShell shim,
// which a child process cannot execute.
import { OpenCodeClient, OpenCodeServer, refreshCatalog } from '../lib/index.js'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Deliberately the unconfigured default, not a resolved path.
const config = { opencodeCommand: 'opencode', host: '127.0.0.1', port: 0, startupTimeoutMs: 120000 }

const server = new OpenCodeServer(config)
const client = new OpenCodeClient(server)

try {
  const address = await server.start()
  check('spawned from the bare name `opencode`', address.baseUrl.startsWith('http://127.0.0.1'), address.baseUrl)
  check('resolved a real executable', typeof server.binary === 'string', server.binary)

  const info = await client.info()
  check('server reachable', typeof info.version === 'string', `v${info.version}`)

  const models = await refreshCatalog(client, 90000)
  check('discovered free models', models.length > 0, `${models.length} model(s)`)
  console.log('      models:', models.map((m) => m.id).join(', '))
} catch (error) {
  check('startup', false, error instanceof Error ? error.message : String(error))
} finally {
  await server.stop()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)