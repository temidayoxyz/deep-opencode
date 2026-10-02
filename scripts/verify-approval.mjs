// The native OpenCode permission request must use the existing DSH approval
// service and its live agent. Provider request IDs are not Harness tool-call IDs.
import assert from 'node:assert/strict'
import test from 'node:test'
import { requestHarnessPermission } from '../lib/index.js'

function context(signal = new AbortController().signal) {
  return {
    harnessSessionId: 'harness-session',
    providerSessionId: 'provider-session',
    event: {
      type: 'permission.asked',
      data: {
        sessionID: 'provider-session', id: 'provider-permission-id',
        action: 'shell', resources: ['node check.js'], message: 'Run test',
      },
    },
    signal,
  }
}

function fixture(verdict) {
  const agent = { id: 'live-harness-agent' }
  const lookups = []
  const requests = []
  const host = {
    agents: { get: (sessionId) => { lookups.push(sessionId); return agent } },
    approval: { request: async (request) => { requests.push(request); return verdict } },
  }
  return { host, agent, lookups, requests }
}

await test('allowed-once approves only the current OpenCode permission request', async () => {
  const { host, agent, lookups, requests } = fixture('allowed-once')
  const requestContext = context()
  assert.equal(await requestHarnessPermission(host, requestContext), 'once')
  assert.deepEqual(lookups, ['harness-session'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].agent, agent, 'the existing DSH agent must own the approval')
  assert.equal(requests[0].signal, requestContext.signal)
  assert.equal(typeof requests[0].toolName, 'string')
  assert.match(requests[0].toolName, /shell/i)
  assert.equal(typeof requests[0].reason, 'string')
  assert.match(requests[0].reason, /shell/i)
  assert.ok(requests[0].reason.includes('node check.js'), 'the user must see the requested resource')
  assert.ok(!Object.hasOwn(requests[0], 'callId'), 'an OpenCode permission ID is not a DSH tool-call ID')
  assert.ok(!requests[0].toolName.includes('provider-permission-id'))
  assert.ok(!requests[0].reason.includes('provider-permission-id'))
})

for (const verdict of ['rejected', 'cancelled']) {
  await test(`a ${verdict} Harness approval rejects the native request`, async () => {
    const { host, requests } = fixture(verdict)
    assert.equal(await requestHarnessPermission(host, context()), 'reject')
    assert.equal(requests.length, 1)
  })
}

await test('unavailable approvals leave the native request for an explicit integration handler', async () => {
  const { host, requests } = fixture('unavailable')
  assert.equal(await requestHarnessPermission(host, context()), undefined)
  assert.equal(requests.length, 1)
})

for (const host of [undefined, {}]) {
  await test(`a ${host === undefined ? 'missing' : 'host without services'} approval host has no decision`, async () => {
    assert.equal(await requestHarnessPermission(host, context()), undefined)
  })
}

await test('a host without the approval service does not approve implicitly', async () => {
  const { host } = fixture('allowed-once')
  delete host.approval
  assert.equal(await requestHarnessPermission(host, context()), undefined)
})

await test('a host without live-agent access does not approve implicitly', async () => {
  const { host, requests } = fixture('allowed-once')
  delete host.agents
  assert.equal(await requestHarnessPermission(host, context()), undefined)
  assert.equal(requests.length, 0)
})

await test('a permission with no Harness session cannot attach an approval to an agent', async () => {
  const { host, lookups, requests } = fixture('allowed-once')
  const requestContext = context()
  delete requestContext.harnessSessionId
  assert.equal(await requestHarnessPermission(host, requestContext), undefined)
  assert.equal(lookups.length, 0)
  assert.equal(requests.length, 0)
})

await test('a Harness session without a live agent cannot request approval', async () => {
  const { host, requests } = fixture('allowed-once')
  host.agents.get = () => undefined
  assert.equal(await requestHarnessPermission(host, context()), undefined)
  assert.equal(requests.length, 0)
})

await test('cancellation cannot convert a late approval into permission to run', { timeout: 2500 }, async () => {
  const controller = new AbortController()
  const { host } = fixture('allowed-once')
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  let approve
  const pendingApproval = new Promise((resolve) => { approve = resolve })
  host.approval.request = () => { ready(); return pendingApproval }
  const pending = requestHarnessPermission(host, context(controller.signal)).then(
    (decision) => ({ decision }),
    (error) => ({ error }),
  )
  await started
  controller.abort(new Error('the user cancelled the turn'))
  approve('allowed-once')
  const result = await pending
  assert.ok(result.error !== undefined || result.decision === 'reject',
    'an aborted turn must throw cancellation or reject the permission')
})
