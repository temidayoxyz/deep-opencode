// Process lifecycle checks using Node as a tiny fake OpenCode executable.
// No network connection or model request is made.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCodeServer, OpenCodeServerPool } from '../lib/index.js'

const root = resolve(tmpdir())
const directory = resolve(mkdtempSync(join(root, 'deep-opencode-server-test-')))
// TEMP may be inside this ESM repository; the fake executable uses require().
writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}')
const config = { opencodeCommand: process.execPath, host: '127.0.0.1', port: 0, startupTimeoutMs: 1000, cwd: directory }
const server = new OpenCodeServer(config)
let held
let descendantPid
try {
  writeFileSync(join(directory, 'serve'), `console.log('server listening on http://127.0.0.1:' + (20000 + process.pid % 20000)); console.log('server password fixture'); setTimeout(() => process.exit(0), 100);`)
  const first = await server.start()
  await delay(250)
  assert.equal(server.baseUrl, undefined, 'an exited child must invalidate its listening address')
  const second = await server.start()
  assert.notEqual(second.baseUrl, first.baseUrl, 'a dead server must launch a new child')
  await server.stop()
  console.log('PASS exited servers restart and explicit stop clears the address')

  writeFileSync(join(directory, 'serve'), `setTimeout(() => { console.log('server listening on http://127.0.0.1:23456'); console.log('server password fixture'); }, 100); setInterval(() => {}, 1000);`)
  const starting = server.start()
  const stopped = server.stop()
  await assert.rejects(starting, /stopped|before listening/)
  await stopped
  assert.equal(server.baseUrl, undefined)
  console.log('PASS stopping during startup cannot resurrect a server')

  if (process.platform === 'win32') {
    writeFileSync(join(directory, 'descendant.cjs'), 'setInterval(() => {}, 1000);')
    writeFileSync(join(directory, 'serve'), `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['descendant.cjs'], {stdio:'ignore', windowsHide:true, detached:true}); child.once('spawn', () => { fs.writeFileSync('descendant.pid', String(child.pid)); console.log('server listening on http://127.0.0.1:23456'); console.log('server password fixture'); }); setInterval(() => {}, 1000);`)
    await server.start()
    descendantPid = Number(readFileSync(join(directory, 'descendant.pid'), 'utf8'))
    process.kill(descendantPid, 0)
    await server.stop()
    await delay(100)
    assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' }, 'stopping a Windows server must stop its owned descendants')
    descendantPid = undefined
    console.log('PASS Windows shutdown stops the owned child process tree')
  }

  const pool = new OpenCodeServerPool(config)
  held = pool.forDirectory(directory, directory)
  await pool.stopAll()
  assert.throws(() => pool.forDirectory(directory, directory), /stopped/)
  await assert.rejects(held.start(), /disposed|stopped/, 'held clients cannot revive disposed managed servers')
  console.log('PASS disposed pools cannot create new servers')
} finally {
  await server.stop()
  await held?.stop()
  if (descendantPid !== undefined) { try { process.kill(descendantPid) } catch {} }
  const location = relative(root, directory)
  assert.ok(location.startsWith('deep-opencode-server-test-') && resolve(root, location) === directory)
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  catch (error) { console.warn(`Test directory retained at ${directory}: ${error.message}`) }
}
