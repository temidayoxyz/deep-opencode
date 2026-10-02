import type { OpenCodeEventContext } from './adapter.ts'
import { abortable } from './turn.ts'

/** Minimal optional Host services; pass the real agent through without copying it. */
export interface HarnessApprovalHost {
  agents?: { get(sessionId: string): unknown }
  approval?: {
    request(options: {
      agent: unknown
      toolName: string
      reason: string
      signal: AbortSignal
    }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
  }
}

/** Route a native permission through DSH's policies, answerers, and audit trail. */
export async function requestHarnessPermission(host: HarnessApprovalHost | undefined,
  context: OpenCodeEventContext): Promise<'once' | 'reject' | undefined> {
  context.signal.throwIfAborted()
  if (context.harnessSessionId === undefined || host?.agents?.get === undefined || host.approval?.request === undefined) return undefined
  const agent = host.agents.get(context.harnessSessionId)
  if (agent === undefined) return undefined
  const request = context.event.data?.request ?? context.event.data
  const details = request as { action?: unknown; resources?: unknown; message?: unknown } | undefined
  const action = typeof details?.action === 'string' ? details.action : 'action'
  const resources = Array.isArray(details?.resources) ? details.resources.filter((item): item is string => typeof item === 'string') : []
  const message = typeof details?.message === 'string' ? details.message : ''
  const decision = await abortable(host.approval.request({
    agent,
    toolName: `opencode:${action}`,
    reason: [`OpenCode requests ${action}${resources.length > 0 ? ` on ${resources.join(', ')}` : ''}.`, message].filter(Boolean).join(' '),
    signal: context.signal,
  }), context.signal)
  context.signal.throwIfAborted()
  if (decision === 'allowed-once') return 'once'
  if (decision === 'rejected' || decision === 'cancelled') return 'reject'
  return undefined
}
