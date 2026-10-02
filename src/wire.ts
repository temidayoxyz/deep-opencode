/**
 * Wire types for the subset of the OpenCode v2 HTTP surface this adapter uses.
 *
 * Every field here is optional except the ones the adapter cannot proceed
 * without, because OpenCode ships several times a day: a field it stops sending
 * must degrade the turn, not crash it. Fields observed on v2.0.18 are
 * documented with the value seen; the adapter never branches on a version
 * string, only on the presence of data.
 */

/** One entry of `GET /api/model` -> `data[]`. */
export interface OpenCodeModelEntry {
  id: string
  modelID?: string
  providerID: string
  name?: string
  capabilities?: {
    tools?: boolean
    input?: readonly string[]
    output?: readonly string[]
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  cost?: readonly { input?: number; output?: number; cache?: { read?: number; write?: number } }[]
}

/** `GET /api/model` response envelope. */
export interface OpenCodeModelList {
  data?: OpenCodeModelEntry[]
}

/** `GET /api/info` response; `version` is reported in diagnostics, never branched on. */
export interface OpenCodeServerInfo {
  version?: string
  pid?: number
  urls?: readonly string[]
}

/** `POST /api/session` -> `data`. */
export interface OpenCodeSession {
  id: string
}

/** Token counters as OpenCode reports them. `input` excludes cached reads. */
export interface OpenCodeTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** One SSE frame from `GET /api/event`. `data` is the event payload. */
export interface OpenCodeEvent {
  type?: string
  created?: number
  data?: {
    sessionID?: string
    assistantMessageID?: string
    /** First-seen block ordinal within the assistant message. */
    ordinal?: number
    delta?: string
    text?: string
    finish?: string
    rawFinish?: string
    cost?: number
    tokens?: OpenCodeTokens
    model?: { id?: string; providerID?: string; variant?: string }
    agent?: string
    [key: string]: unknown
  }
}

/**
 * Event names the translator recognises. Aliases cover the older
 * `session.reasoning.*` spelling so a turn keeps working if OpenCode renames
 * one family; an unrecognised event is ignored rather than fatal.
 */
export const TEXT_STARTED = 'session.text.started'
export const TEXT_DELTA = 'session.text.delta'
export const TEXT_ENDED = 'session.text.ended'
export const REASONING_STARTED = ['session.reasoning.started', 'session.thinking.started']
export const REASONING_DELTA = ['session.reasoning.delta', 'session.thinking.delta']
export const REASONING_ENDED = ['session.reasoning.ended', 'session.thinking.ended']
export const STEP_ENDED = 'session.step.ended'
export const EXECUTION_SUCCEEDED = 'session.execution.succeeded'
export const EXECUTION_FAILED = [
  'session.execution.failed',
  'session.error',
  'session.execution.aborted',
  'session.execution.interrupted',
]
