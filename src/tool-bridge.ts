import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createAssistantMessage, createToolResultMessage, LlmError, type ContentBlock, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TurnContext } from './prompt.ts'

interface ToolOutcome {
  isError: boolean
  content: ContentBlock[]
  error?: { message: string; info?: { name: string; code: string; reason?: string } }
  meta?: unknown
  additionalContexts?: { content: ContentBlock[]; [key: string]: unknown }[]
  concludesTurn?: true
}

/** The same-process Host seam. Definitions themselves never cross the wire. */
export interface HarnessToolHost {
  agents: { get(id: string): HarnessToolAgent | undefined }
  tools: {
    execute(input: { callId: string; name: string; arguments: unknown; agent: HarnessToolAgent; signal: AbortSignal }): Promise<ToolOutcome>
  }
  position(agent: HarnessToolAgent): { turn: number; step: number } | undefined
}

export interface HarnessToolAgent {
  readonly id: string
  readonly session: {
    append(type: string, data: unknown, options?: { surfaceOp: 'append'; sourceEventSeqs?: number[] }): { seq: number }
  }
}

export interface ToolBridgeTurn {
  harnessSessionId?: string
  providerSessionId: string
  model?: string
  system?: string
  context?: TurnContext
  tools: readonly ToolSchema[]
  signal: AbortSignal
}

export interface ToolBridgeBinding {
  readonly concluded: boolean
  close(): Promise<void>
}

interface Binding extends ToolBridgeBinding {
  readonly turn: ToolBridgeTurn
  readonly owner?: { host: HarnessToolHost; agent: HarnessToolAgent; position: { turn: number; step: number } }
  readonly schemas: ReadonlyMap<string, ToolSchema>
  readonly abort: AbortController
  readonly signal: AbortSignal
  readonly calls: Map<string, { payload: string; task: Promise<ToolOutcome> }>
  queue: Promise<unknown>
  closed: boolean
  concluded: boolean
}

class BridgeError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const MAX_BODY_BYTES = 1_048_576

/** Authenticated loopback transport, scoped to a single active delegated turn. */
export class HarnessToolBridge {
  readonly #host: () => HarnessToolHost | undefined
  readonly #token = randomBytes(32).toString('hex')
  readonly #bindings = new Map<string, Binding>()
  #server: Server | undefined
  #starting: Promise<{ baseUrl: string; token: string }> | undefined
  #disposed = false

  constructor(host: () => HarnessToolHost | undefined) { this.#host = host }

  start(): Promise<{ baseUrl: string; token: string }> {
    if (this.#disposed) return Promise.reject(new LlmError('DSH tool bridge has been unloaded', 'ABORTED'))
    return this.#starting ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.#handle(request, response) })
      this.#server = server
      server.requestTimeout = 30_000
      server.headersTimeout = 10_000
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        if (this.#disposed) return reject(new LlmError('DSH tool bridge has been unloaded', 'ABORTED'))
        const address = server.address()
        if (typeof address !== 'object' || address === null) return reject(new Error('DSH tool bridge has no listening address'))
        resolve({ baseUrl: `http://127.0.0.1:${address.port}`, token: this.#token })
      })
      server.unref()
    })
  }

  bind(turn: ToolBridgeTurn): ToolBridgeBinding {
    turn.signal.throwIfAborted()
    if (this.#disposed) throw new LlmError('DSH tool bridge has been unloaded', 'ABORTED')
    const host = this.#host()
    const agent = turn.harnessSessionId === undefined ? undefined : host?.agents.get(turn.harnessSessionId)
    const position = agent === undefined ? undefined : host?.position(agent)
    if (turn.tools.length > 0 && (host === undefined || typeof host.tools?.execute !== 'function' || agent === undefined || position === undefined)) {
      throw new LlmError('DSH tools need a live agent, tool runtime, and open step to run through OpenCode', 'NO_TOOL_BRIDGE')
    }
    if (this.#bindings.has(turn.providerSessionId)) throw new LlmError('DSH tool bridge session is already bound', 'PROTOCOL')
    const abort = new AbortController()
    const binding: Binding = {
      turn, abort,
      owner: turn.tools.length > 0 && host !== undefined && agent !== undefined && position !== undefined ? { host, agent, position } : undefined,
      signal: AbortSignal.any([turn.signal, abort.signal]),
      schemas: new Map(turn.tools.map(schema => [schema.name, JSON.parse(JSON.stringify(schema)) as ToolSchema])),
      calls: new Map(), queue: Promise.resolve(), closed: false, concluded: false,
      close: async () => {
        binding.closed = true
        abort.abort()
        // A policy/tool promise is owned work: drain it before releasing the step.
        await binding.queue.catch(() => undefined)
        if (this.#bindings.get(turn.providerSessionId) === binding) this.#bindings.delete(turn.providerSessionId)
      },
    }
    this.#bindings.set(turn.providerSessionId, binding)
    return binding
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.all([...this.#bindings.values()].map(binding => binding.close()))
    // Closing before the listen callback can leave start() permanently pending.
    await this.#starting?.catch(() => undefined)
    if (this.#server !== undefined) {
      const server = this.#server
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
      this.#server = undefined
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const provided = Buffer.from(request.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${this.#token}`)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new BridgeError('Unauthorized', 401)
      if (request.headers.origin !== undefined) throw new BridgeError('Browser origins are not accepted', 403)
      if (request.method !== 'POST') throw new BridgeError('Use POST', 405)
      if (request.url !== '/context' && request.url !== '/tools/list' && request.url !== '/tools/call') throw new BridgeError('Unknown bridge route', 404)
      if (!request.headers['content-type']?.startsWith('application/json')) throw new BridgeError('Use application/json', 415)
      const body = await readBody(request)
      const binding = typeof body.sessionId === 'string' ? this.#bindings.get(body.sessionId) : undefined
      if (binding === undefined || binding.closed || binding.signal.aborted) throw new BridgeError('No active DSH tool session', 403)
      if (binding.owner !== undefined && !this.#ownsOpenStep(binding)) throw new BridgeError('DSH tool owner is no longer available', 403)
      if (request.url === '/tools/list' || request.url === '/context') {
        const context = binding.turn.context
        if (request.url === '/context' && body.phase === 'context' && context !== undefined) {
          if (!Array.isArray(body.messageIds) || body.messageIds.some(id => typeof id !== 'string')) throw new BridgeError('Invalid native message identities', 400)
          const ids = new Set(body.messageIds)
          // Primary hooks see the complete active native history. An absent
          // anchor has become a checkpoint; retirement survives later bindings.
          for (const group of context.replay) if (!ids.has(group.before)) group.compacted = true
        }
        send(response, 200, { tools: [...binding.schemas.values()], concluded: binding.concluded,
          ...(request.url === '/context' ? { system: binding.turn.system, context: context === undefined ? undefined : {
            ...context, replay: context.replay.filter(group => !group.compacted).map(({ before, messages }) => ({ before, messages })),
          } } : {}),
        })
        return
      }
      if (typeof body.name !== 'string' || !binding.schemas.has(body.name)) throw new BridgeError('Tool is not available in this DSH request', 403)
      if (typeof body.callId !== 'string' || body.callId.length === 0 || body.callId.length > 200) throw new BridgeError('Invalid tool call identity', 400)
      if (body.arguments === null || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) throw new BridgeError('Tool arguments must be an object', 400)
      const payload = JSON.stringify([body.name, body.arguments])
      const previous = binding.calls.get(body.callId)
      if (previous !== undefined && previous.payload !== payload) throw new BridgeError('Tool call identity was reused with different input', 409)
      if (previous === undefined && (binding.concluded || binding.calls.size >= 512)) throw new BridgeError('This DSH turn accepts no further tool calls', 409)
      const caller = new AbortController()
      const disconnect = () => { if (!response.writableFinished) caller.abort() }
      response.once('close', disconnect)
      try {
        let task = previous?.task
        if (task === undefined) {
          const signal = AbortSignal.any([binding.signal, caller.signal])
          task = binding.queue.then(() => this.#execute(binding, body.name as string, body.arguments, signal))
          binding.calls.set(body.callId, { payload, task })
          binding.queue = task.catch(() => undefined)
        }
        const result = await task
        send(response, 200, {
          isError: result.isError,
          content: result.content,
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
          ...(result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts }),
          ...(result.concludesTurn === true ? { concludesTurn: true } : {}),
        })
      } finally { response.off('close', disconnect) }
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500
      send(response, status, { error: error instanceof BridgeError ? error.message : 'DSH tool bridge failed' })
    }
  }

  #ownsOpenStep(binding: Binding): boolean {
    const owner = binding.owner
    if (owner === undefined || owner.host !== this.#host() || owner.host.agents.get(owner.agent.id) !== owner.agent) return false
    const current = owner.host.position(owner.agent)
    return current?.turn === owner.position.turn && current.step === owner.position.step
  }

  async #execute(binding: Binding, name: string, args: unknown, signal: AbortSignal): Promise<ToolOutcome> {
    signal.throwIfAborted()
    const owner = binding.owner
    if (owner === undefined || binding.closed || binding.concluded || !this.#ownsOpenStep(binding)) throw new BridgeError('DSH tool owner is no longer available', 403)
    const { turn, step } = owner.position
    const callId = `opencode-${randomUUID()}` as Branded<'CallId'>
    const argumentsText = JSON.stringify(args)
    const session = owner.agent.session
    // This is already executed here, so it must not enter the outer stream's
    // tool-call blocks and trigger a second dispatch in the Harness agent loop.
    session.append('assistant/message', {
      turn, step, stream: [],
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name, arguments: argumentsText }], source: { provider: 'opencode-free', model: binding.turn.model ?? 'unknown' } }),
    }, { surfaceOp: 'append' })
    const call = session.append('tool/call', { turn, step, callId, name, arguments: argumentsText })
    let result: ToolOutcome
    try {
      result = await owner.host.tools.execute({ callId, name, arguments: args, agent: owner.agent, signal })
      if (signal.aborted && !result.isError) result = abortedResult()
    } catch {
      result = signal.aborted ? abortedResult() : { isError: true, content: [{ type: 'text', text: 'Error: DSH tool execution failed' }] }
    }
    session.append('tool/result', {
      turn, step,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.error?.info === undefined ? {} : { error: result.error.info }),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    for (const message of result.additionalContexts ?? []) session.append('user/message', message, { surfaceOp: 'append' })
    if (!result.isError && result.concludesTurn) binding.concluded = true
    return result
  }
}

function abortedResult(): ToolOutcome {
  return { isError: true, content: [{ type: 'text', text: 'Error: DSH tool call cancelled' }], error: { message: 'DSH tool call cancelled', info: { name: 'AbortError', code: 'ABORTED' } } }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BridgeError('Request body is too large', 413)
    chunks.push(chunk)
  }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BridgeError('Invalid JSON', 400) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BridgeError('Expected a JSON object', 400)
  return body as Record<string, unknown>
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}
