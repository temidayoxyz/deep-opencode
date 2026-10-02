// A running native companion must not prevent replacing its installed package.
// Only fixture-owned package folders are renamed; every native runtime path is
// outside them so a project cwd cannot explain the package lock.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessToolBridge, OpenCodeClient, OpenCodeCompanion, OpenCodeServerPool, authorizationHeader, toolBridgeEnvironment } from '../lib/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = await mkdtemp(join(root, '.plugin-update-verification-'))
const binary = join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe')
const companion = fileURLToPath(new URL('../lib/opencode/', import.meta.url))
const owned = path => {
  const suffix = relative(workspace, resolve(path))
  assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), `Unexpected fixture path: ${path}`)
  return path
}

async function probe(staged) {
  const directory = join(workspace, staged ? 'staged' : 'installed')
  const packageDirectory = join(directory, 'node_modules', 'dsh-deep-opencode')
  const runtimeDirectory = join(directory, 'native-runtime')
  const projectDirectory = join(directory, 'project')
  await mkdir(packageDirectory, { recursive: true })
  await mkdir(projectDirectory, { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), '{"name":"dsh-deep-opencode","type":"module"}')
  const installedCompanion = join(packageDirectory, 'lib', 'opencode')
  await cp(companion, installedCompanion, { recursive: true })
  const paths = Object.fromEntries(await Promise.all(['data', 'state', 'cache', 'config', 'temp'].map(async name => {
    const path = join(runtimeDirectory, name)
    await mkdir(path, { recursive: true })
    return [name, path]
  })))
  const staging = staged ? new OpenCodeCompanion(installedCompanion, paths.temp) : undefined
  const pluginDirectory = staging === undefined ? installedCompanion : await staging.directory()
  const pluginRelativePath = relative(packageDirectory, pluginDirectory)
  if (staging !== undefined) {
    assert.ok(pluginRelativePath.startsWith('..'), 'companion must be staged outside the installed package')
    assert.equal(await readFile(join(pluginDirectory, 'index.js'), 'utf8'), await readFile(join(installedCompanion, 'index.js'), 'utf8'))
  } else {
    assert.ok(!pluginRelativePath.startsWith('..') && !isAbsolute(pluginRelativePath), 'control companion must remain inside the installed package')
  }
  const bridge = new HarnessToolBridge(() => undefined)
  const pool = new OpenCodeServerPool({
    opencodeCommand: existsSync(binary) ? binary : 'opencode', host: '127.0.0.1', port: 0, startupTimeoutMs: 60_000,
  }, async () => ({
    ...await toolBridgeEnvironment(bridge, pluginDirectory),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [pluginDirectory] }),
    XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state, XDG_CACHE_HOME: paths.cache, XDG_CONFIG_HOME: paths.config,
    TEMP: paths.temp, TMP: paths.temp,
  }))
  const destination = owned(join(directory, 'node_modules', 'dsh-deep-opencode_replaced'))
  owned(packageDirectory)
  try {
    const server = pool.forDirectory(undefined, projectDirectory)
    const client = new OpenCodeClient(server)
    console.log(`${staged ? 'STAGED' : 'INSTALLED'} OPENCODE`, JSON.stringify(await client.info()))
    await client.listModels()
    const address = await server.start()
    let active = false
    const deadline = Date.now() + 30_000
    do {
      const response = await fetch(`${address.baseUrl}/api/plugin`, { headers: { Authorization: authorizationHeader(address.password) }, signal: AbortSignal.timeout(5_000) })
      const body = await response.json()
      assert.ok(response.ok, JSON.stringify(body))
      const entry = body.data?.find(plugin => plugin.id === 'dsh-tool-bridge')
      if (entry?.state?.status === 'failed') assert.fail(JSON.stringify(entry))
      if (entry?.state?.status === 'active') { active = true; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    assert.ok(active, 'the real native companion must be active before the rename')
    let result = 'renamed'
    try { await rename(packageDirectory, destination) }
    catch (error) { result = error.code ?? error.message }
    console.log(`${staged ? 'STAGED' : 'INSTALLED'} PACKAGE RENAME`, result)
    return result
  } finally {
    try { await pool.stopAll() } finally {
      try { await bridge.dispose() } finally { await staging?.dispose() }
    }
  }
}

try {
  const installed = await probe(false)
  const staged = await probe(true)
  assert.equal(staged, 'renamed', 'staging outside the package must allow replacement while OpenCode runs')
  if (process.platform === 'win32') assert.equal(installed, 'EPERM', 'the current in-package companion must reproduce the reported native Windows lock')
  console.log('PASS isolated native package replacement comparison')
} finally {
  const suffix = relative(root, workspace)
  assert.ok(suffix.startsWith('.plugin-update-verification-') && !suffix.includes('..') && resolve(root, suffix) === workspace)
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
