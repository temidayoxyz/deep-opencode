import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenCodeClient } from '../lib/index.js'

const server = { cwd: process.cwd(), start: async () => ({ baseUrl: 'http://test.invalid', password: 'fixture' }) }

await test('SSE accepts CRLF frames, split chunks, and multiline data', async () => {
  const original = globalThis.fetch
  const encoder = new TextEncoder()
  const bytes = 'data: {"type":"server.connected"}\r\n\r\ndata: {"type":"session.text.delta",\r\ndata: "data":{"delta":"hello"}}\r\n\r\n'
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(encoder.encode(bytes.slice(offset, offset + 7)))
      controller.close()
    },
  }))
  try {
    const events = []
    for await (const event of new OpenCodeClient(server).events(new AbortController().signal)) events.push(event)
    assert.equal(events.length, 2)
    assert.equal(events[1].data.delta, 'hello')
  } finally { globalThis.fetch = original }
})

await test('session creation supplies the native location and explicit permission rules', async () => {
  const original = globalThis.fetch
  let body
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(init.body)
    return Response.json({ data: { id: 'ses_fixture' } })
  }
  try {
    const permissions = [{ action: 'read', resource: '*', effect: 'allow' }]
    assert.equal(await new OpenCodeClient(server).createSession(undefined, permissions, 'custom-agent'), 'ses_fixture')
    assert.deepEqual(body.location, { directory: process.cwd() })
    assert.deepEqual(body.permissions, permissions)
    assert.equal(body.agent, 'custom-agent')
  } finally { globalThis.fetch = original }
})
