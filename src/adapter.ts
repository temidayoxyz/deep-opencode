/**
 * The `opencode-free` adapter: one delegated turn per model request.
 *
 * OpenCode's Zen endpoint refuses its free models for clients that are not
 * OpenCode, so this adapter does not call the gateway at all. It runs a real
 * `opencode serve` and asks that process to run the turn, translating the
 * server's event stream into the harness stream protocol. This is the same
 * arrangement OpenChamber uses, and the reason no API key is involved.
 *
 * Protocol obligations honoured here: `usage` precedes `finish`, nothing is
 * emitted after `finish`, and block indexes remain distinct across all model
 * steps. Transport errors are normalised by the Harness LLM service.
 */
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { randomBytes } from 'node:crypto'
import { OpenCodeClient, OpenCodeRequestError, type PermissionRule } from './client.ts'
import { abortable, turnScope } from './turn.ts'
import type { HarnessToolBridge, ToolBridgeBinding } from './tool-bridge.ts'
import { OpenCodeServer, OpenCodeServerPool } from './server.ts'
import { OPENCODE_PROVIDER, type FreeModel } from './catalog.ts'
import { listModelInfo, refreshCatalog } from './discovery.ts'
import { buildSystem, contextMessages, type ContextReplay } from './prompt.ts'
import { digest, planTurn, type SessionRegistry, type SessionState } from './session-registry.ts'
import {
  EXECUTION_FAILED,
  EXECUTION_SUCCEEDED,
  REASONING_DELTA,
  REASONING_ENDED,
  REASONING_STARTED,
  STEP_ENDED,
  TEXT_DELTA,
  TEXT_ENDED,
  TEXT_STARTED,
  type OpenCodeEvent,
} from './wire.ts'

/**
 * A single-consumer async queue fed by a background reader.
 *
 * The provider's event stream is consumed by its own task while the request's
 * generator drains this queue, which keeps the stream protocol's yields in one
 * place and lets the subscription be established before the prompt is sent.
 */
class AsyncQueue<T> {
  readonly #items: T[] = []
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = []
  #failure: LlmError | undefined
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: item, done: false })
      return
    }
    this.#items.push(item)
  }

  /** Records the failure and closes; a failure is reported after queued chunks. */
  fail(error: LlmError): void {
    this.#failure = error
    this.close()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as T, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.#items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.#closed) {
        // Chunks queued before the failure are already delivered, so a turn that
        // streamed text and then failed still yields that text.
        if (this.#failure !== undefined) throw this.#failure
        return
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push((result) => {
          if (result.done === false) this.#items.unshift(result.value)
          resolve()
        })
      })
    }
  }
}

/**
 * Block indexes and accumulated usage for one delegated execution.
 *
 * The harness requires indexes to be allocated in first-seen stream order and
 * reused for every delta of the same block. OpenCode's `reasoning` and `text`
 * events each number their own blocks from zero, so its ordinal cannot be used
 * as the harness index: reasoning 0 and text 0 would collide and one block
 * would replace the other. Each provider block therefore gets the next harness
 * index on first sight, keyed by its kind and ordinal.
 */
interface BlockState {
  next: number
  indexes: Map<string, number>
  assistantMessageID: string | undefined
  usage: ReturnType<typeof toUsage> | undefined
  finish: { kind: 'stop' } | { kind: 'max-tokens' }
}

function freshBlocks(): BlockState {
  return { next: 0, indexes: new Map(), assistantMessageID: undefined, usage: undefined, finish: { kind: 'stop' } }
}

/** Allocates the harness index for one provider block, reusing it after the first sight. */
function indexFor(blocks: BlockState, kind: 'text' | 'reasoning', ordinal: number): number {
  const key = `${kind}:${ordinal}`
  const existing = blocks.indexes.get(key)
  if (existing !== undefined) return existing
  const allocated = blocks.next++
  blocks.indexes.set(key, allocated)
  return allocated
}

/** Resolves the project directory one request should run its agent in. */
export type DirectoryResolver = (sessionId: Branded<'SessionId'> | undefined) => string | undefined

/** A model request delegated to a running OpenCode server. */
export class OpenCodeFreeAdapter extends LlmAdapter {
  readonly #pool: OpenCodeServerPool
  readonly #fallbackDirectory: string
  readonly #resolveDirectory: DirectoryResolver
  readonly #registry: SessionRegistry | undefined
  readonly #reuseSessions: boolean
  readonly #turnTimeoutMs: number
  readonly #catalogTimeoutMs: number
  /** The in-flight background catalogue read, so concurrent picks share one. */
  #refreshInFlight: Promise<readonly LlmModelInfo[]> | undefined
  /** Whether the harness system prompt and tool list are forwarded verbatim. */
  readonly #forwardHarnessContext: boolean
  readonly #integration: OpenCodeIntegration
  readonly #turns = new Map<ReturnType<typeof turnScope>, Promise<void>>()
  #disposed = false

  constructor(
    pool: OpenCodeServerPool,
    fallbackDirectory: string,
    resolveDirectory: DirectoryResolver,
    turnTimeoutMs: number,
    catalogTimeoutMs: number,
    registry?: SessionRegistry,
    reuseSessions = true,
    forwardHarnessContext = false,
    integration: OpenCodeIntegration = {},
  ) {
    super()
    this.#pool = pool
    this.#fallbackDirectory = fallbackDirectory
    this.#resolveDirectory = resolveDirectory
    this.#registry = registry
    this.#reuseSessions = reuseSessions
    this.#turnTimeoutMs = turnTimeoutMs
    this.#catalogTimeoutMs = catalogTimeoutMs
    this.#forwardHarnessContext = forwardHarnessContext
    this.#integration = integration
  }

  /** The server owning one request's project directory. */
  #serverFor(sessionId: Branded<'SessionId'> | undefined): OpenCodeServer {
    return this.#pool.forDirectory(this.#resolveDirectory(sessionId), this.#fallbackDirectory)
  }

  /** A client bound to the server owning this request's project directory. */
  #clientFor(sessionId: Branded<'SessionId'> | undefined): OpenCodeClient {
    return new OpenCodeClient(this.#serverFor(sessionId))
  }

  /** Route display metadata for the selector. */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'OpenCode Free' }
  }

  /**
   * The free models the running server offers.
   *
   * Read from the server rather than a pinned list, so a free model OpenCode
   * adds appears without a plugin update. An unreachable server advertises
   * nothing, which leaves the route unselectable in the GUI instead of
   * offering a model that would fail. The catalogue is provider-wide, so it is
   * read from the fallback directory's server rather than starting one per
   * project.
   */
  override async listModels(): Promise<readonly LlmModelInfo[]> {
    const known = listModelInfo()
    if (known.length > 0) {
      // Answer from the catalogue already discovered, and refresh behind it.
      // The picker is asked for a list on every render, and a fresh read costs
      // seconds while a server is still fetching its providers, so awaiting one
      // here is what leaves the route unselectable even though the models exist.
      this.#refreshInBackground()
      return known
    }
    try {
      const models = await refreshCatalog(this.#clientFor(undefined), this.#catalogTimeoutMs)
      if (models.length > 0) return models
      // The fallback server answered empty. A chat may already be running on
      // another server that did fetch its providers, and its catalogue is the
      // same list, so any server in the pool is worth asking.
      return await this.#catalogFromAnyRunningServer()
    } catch {
      return listModelInfo()
    }
  }

  /**
   * Refreshes the catalogue without making the caller wait for it.
   *
   * A read that fails leaves the previous catalogue in place, so a picker that
   * refreshes in the background never sees the list empty out from under it.
   */
  #refreshInBackground(): void {
    this.#refreshInFlight ??= refreshCatalog(this.#clientFor(undefined), this.#catalogTimeoutMs)
      .catch(() => listModelInfo())
      .finally(() => {
        this.#refreshInFlight = undefined
      })
  }

  /** The catalogue, read from whichever server in the pool can report one. */
  async #catalogFromAnyRunningServer(): Promise<readonly LlmModelInfo[]> {
    const fallback = this.#pool.forDirectory(undefined, this.#fallbackDirectory).cwd
    for (const directory of this.#pool.directories) {
      if (fallback !== undefined && directory.toLowerCase() === fallback.toLowerCase()) continue
      try {
        const models = await refreshCatalog(
          new OpenCodeClient(this.#pool.forDirectory(directory, this.#fallbackDirectory)),
          Math.min(this.#catalogTimeoutMs, 15_000),
        )
        if (models.length > 0) return models
      } catch {
        // The next server may still answer; a failure here is not the answer.
      }
    }
    return listModelInfo()
  }

  /**
   * Metadata for one exact model, from the same discovery read.
   *
   * Resolution is advisory and independent of the catalogue, so an id the
   * catalogue does not list still resolves and a request can still route; the
   * GUI is the surface that requires membership.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const models = await this.listModels()
    const found = models.find((entry) => entry.id === model)
    const resolved: LlmResolvedModelInfo = { provider, id: model, name: found?.name ?? model }
    const context = (found as FreeModel | undefined)?.context
    if (context !== undefined) resolved.context = context
    if (found?.inputModalities !== undefined) resolved.inputModalities = found.inputModalities
    return resolved
  }

  /**
   * Runs one delegated turn.
   *
   * A harness session is mapped onto one OpenCode session so the provider keeps
   * the conversation, and only what is new is sent. When no mapping exists, or
   * the cursor found the history had been rewritten, the whole conversation is
   * replayed into a fresh provider session instead, so a divergence costs
   * continuity rather than a failed turn. Turns are serialised per harness
   * session so two cannot read the same cursor.
   *
   * The request runs against the server owning the session's project directory,
   * and session creation specifies its native location explicitly.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.#disposed) throw new LlmError('OpenCode adapter has been unloaded', 'ABORTED')
    const scope = turnScope(options.signal, this.#turnTimeoutMs)
    const queue = new AsyncQueue<StreamChunk>()
    const registry = this.#registry
    // Titles and compaction are auxiliary calls, not the conversation's next turn.
    const mapped = options.sessionId !== undefined && options.purpose === undefined && this.#reuseSessions && registry !== undefined
    const onAbort = () => queue.fail(toLlmError(scope.signal.reason))
    scope.signal.addEventListener('abort', onAbort, { once: true })
    if (scope.signal.aborted) onAbort()

    const run = async (state?: SessionState): Promise<void> => {
      scope.signal.throwIfAborted()
      const conversation = digest(options)
      const server = this.#serverFor(options.sessionId)
      const client = new OpenCodeClient(server)
      const entry = state?.entry
      let sessionId = entry?.opencodeSessionId ?? ''
      let succeeded = false
      let terminal: Extract<StreamChunk, { type: 'finish' }> | undefined
      let reader: AsyncIterator<OpenCodeEvent> | undefined
      let toolBinding: ToolBridgeBinding | undefined
      const subscription = new AbortController()
      const signal = AbortSignal.any([scope.signal, subscription.signal])
      // Context is supplied through the companion rather than the human prompt.
      // A completed synthetic turn can have no conversational anchor yet.
      // Its native assistant/tool history still exists and must be retained.
      let plan = entry?.preambleSent && entry.history?.length === 0
        ? { messages: conversation.filter(message => message.role !== 'assistant' || message.delegated === false), sendPreamble: false, resendAll: false }
        : planTurn(conversation, entry?.sentThrough, entry?.preambleSent ?? false)
      if (entry !== undefined && (entry.directory !== server.cwd || entry.history?.some((previous, index) => {
        const current = conversation[index]
        return current?.id !== previous.id || current?.role !== previous.role || current?.text !== previous.text
      }))) {
        plan = { messages: conversation, sendPreamble: true, resendAll: true }
      }
      try {
        if (sessionId === '' || plan.resendAll) {
          const previous = sessionId
          const creating = client.createSession(signal, this.#integration.permissions, this.#integration.agent)
          // A late response after cancellation must not orphan a provider session.
          void creating.then((id) => { if (scope.signal.aborted) void client.deleteSession(id) }, () => undefined)
          sessionId = await abortable(creating, signal)
          if (entry !== undefined) {
            entry.opencodeSessionId = sessionId
            entry.directory = server.cwd
            entry.sentThrough = undefined
            entry.history = undefined
            entry.replay = undefined
            entry.sentCount = 0
            entry.preambleSent = false
            registry?.bindClient(sessionId, client)
          }
          if (previous !== '') await registry?.deleteSessions([previous])
        }
        const injected = contextMessages(options)
        const humanIndex = options.purpose === undefined ? plan.messages.findLastIndex(message => message.role === 'user' && message.text.length > 0) : -1
        const human = plan.messages[humanIndex]
        if (human === undefined && injected.length === 0 && !(options.purpose !== undefined && (options.system || plan.messages.some(message => message.text.length > 0)))) {
          throw new LlmError('opencode-free received a request with no new text to send', 'INVALID_REQUEST')
        }
        const promptId = `msg_${randomBytes(32).toString('hex')}`
        const replayMessages = plan.messages.filter((message, index) => index !== humanIndex && message.text.length > 0).map(({ role, text }) => ({ role, text }))
        const replay: readonly ContextReplay[] = [...(entry?.replay ?? []).filter(group => !group.compacted), ...(replayMessages.length > 0 ? [{ before: promptId, messages: replayMessages }] : [])]
        if (this.#integration.toolBridge !== undefined) {
          toolBinding = this.#integration.toolBridge.bind({
            harnessSessionId: options.sessionId, providerSessionId: sessionId,
            tools: options.sessionId !== undefined && options.purpose === undefined && this.#integration.bridgeHarnessTools !== false ? options.tools ?? [] : [],
            model: options.model, system: buildSystem(options, options.purpose === undefined ? server.cwd : undefined, this.#forwardHarnessContext), signal,
            context: { before: promptId, replay, messages: injected },
          })
        } else if (injected.length > 0 || replay.length > 0 || options.system) {
          throw new LlmError('DSH context and history replay require the OpenCode companion transport', 'NO_TOOL_BRIDGE')
        }
        await abortable(client.setModel(sessionId, options.model, OPENCODE_PROVIDER, signal), signal)
        const text = human?.text ?? 'Continue using the current DSH context.'
        const blocks = freshBlocks()
        let finished = false
        reader = client.events(signal)[Symbol.asyncIterator]()
        const opened = await abortable(reader.next(), signal)
        if (opened.done) throw new LlmError('OpenCode event stream closed before prompting', 'PROTOCOL')
        // Drain while admission is in flight: events are volatile, and tool
        // requests can arrive before the prompt HTTP response does.
        const pump = (async () => {
          for (;;) {
            const step = await abortable(reader!.next(), signal)
            if (step.done) {
              if (!finished) throw new LlmError('OpenCode ended the turn without a terminal event', 'PROTOCOL')
              return
            }
            const event = step.value
            const owner = event.data?.sessionID ?? (event.data?.form as { sessionID?: string } | undefined)?.sessionID
              ?? (event.data?.request as { sessionID?: string } | undefined)?.sessionID
            if (owner !== sessionId) continue
            await abortable(Promise.resolve(this.#integration.onEvent?.({ harnessSessionId: options.sessionId, providerSessionId: sessionId, event, signal })), signal)
            await this.#handleInteraction(client, sessionId, event, options.sessionId, signal)
            for (const chunk of translate(event, blocks)) {
              if (chunk.type === 'finish') {
                finished = true
                terminal = chunk
              } else {
                queue.push(chunk)
              }
            }
            if (finished) return
          }
        })()
        // Observe a reader failure even if prompt admission itself is stalled.
        void pump.catch(() => undefined)
        await abortable(Promise.all([client.prompt(sessionId, text, signal, { id: promptId, synthetic: human === undefined }), pump]), signal)
        succeeded = terminal?.reason.kind === 'stop' || terminal?.reason.kind === 'max-tokens'
        if (succeeded && entry !== undefined) {
          // Commit only accepted, completed history. Its own assistant output
          // is already in OpenCode and is skipped on the next delta.
          entry.sentThrough = conversation.at(-1)?.id
          entry.sentCount = conversation.length
          entry.preambleSent = true
          entry.history = conversation
          entry.replay = replay
        }
      } finally {
        subscription.abort()
        void reader?.return?.(undefined).catch(() => undefined)
        if (!succeeded && sessionId !== '') {
          await client.interrupt(sessionId)
          if (entry !== undefined) {
            entry.opencodeSessionId = ''
            entry.sentThrough = undefined
            entry.history = undefined
            entry.replay = undefined
            entry.preambleSent = false
          }
        }
        if ((!mapped || !succeeded) && sessionId !== '') {
          if (mapped) await registry!.deleteSessions([sessionId])
          else await client.deleteSession(sessionId)
        }
        await toolBinding?.close()
      }
      if (terminal !== undefined) queue.push(terminal)
    }
    const task = (mapped ? registry!.withEntry(options.sessionId!, run) : run())
      .catch((error) => queue.fail(toLlmError(error)))
      .then(async () => {
        if (registry !== undefined) await registry.deleteSessions(await registry.reclaim())
      })
      .catch((error) => queue.fail(toLlmError(error)))
      .finally(() => { queue.close(); this.#turns.delete(scope) })
    this.#turns.set(scope, task)
    try {
      for await (const chunk of queue) yield chunk
    } finally {
      scope.abort()
      scope.dispose()
      scope.signal.removeEventListener('abort', onAbort)
      // DSH must not close its step while a forwarded tool still owns work.
      if (this.#integration.toolBridge !== undefined) await task
    }
  }

  /** End every delegated execution before stopping its managed servers. */
  async dispose(): Promise<void> {
    this.#disposed = true
    for (const scope of this.#turns.keys()) scope.abort()
    await Promise.allSettled(this.#turns.values())
  }

  async #handleInteraction(client: OpenCodeClient, sessionId: string, event: OpenCodeEvent,
    harnessSessionId: Branded<'SessionId'> | undefined, signal: AbortSignal): Promise<void> {
    const context = { harnessSessionId, providerSessionId: sessionId, event, signal }
    if (event.type === 'permission.asked' || event.type === 'session.permission.asked' || event.type === 'permission.requested') {
      const request = event.data?.request ?? event.data
      const id = (request as { id?: string } | undefined)?.id
      const decision = await abortable(Promise.resolve(this.#integration.onPermission?.(context)), signal)
      if (id === undefined || !['once', 'always', 'reject'].includes(decision ?? '')) {
        throw new LlmError('OpenCode needs permission to continue. Connect a deep-opencode/permission handler or configure session permissions.', 'INTERACTION_REQUIRED')
      }
      await abortable(client.replyPermission(sessionId, id, decision!, signal), signal)
    }
    if (event.type === 'session.form.created' || event.type === 'form.created') {
      const form = event.data?.form ?? event.data
      const id = (form as { id?: string } | undefined)?.id
      const answer = await abortable(Promise.resolve(this.#integration.onForm?.(context)), signal)
      if (id === undefined || answer === undefined) {
        throw new LlmError('OpenCode needs an answer to continue. Connect a deep-opencode/form handler.', 'INTERACTION_REQUIRED')
      }
      await abortable(client.replyForm(sessionId, id, answer, signal), signal)
    }
  }
}

/**
 * Maps one server event onto zero or more stream chunks.
 *
 * Unknown event types yield nothing rather than failing the turn, so a renamed
 * auxiliary event costs observability but not the request. A turn that produces
 * no text at all still fails, at the caller, because a silent empty turn is the
 * one drift that must not pass unnoticed.
 */
function* translate(event: OpenCodeEvent, blocks: BlockState): Generator<StreamChunk> {
  const type = event.type
  if (type === undefined) return
  const data = event.data ?? {}

  if (data.assistantMessageID !== undefined) {
    // Provider ordinals restart each model step; Harness indexes span the run.
    if (blocks.assistantMessageID !== data.assistantMessageID) {
      blocks.indexes.clear()
      blocks.assistantMessageID = data.assistantMessageID
    }
  }

  if (type === TEXT_STARTED) {
    yield { type: 'block-start', index: indexFor(blocks, 'text', data.ordinal ?? 0), blockType: 'text' }
    return
  }

  if (type === TEXT_DELTA) {
    if (data.delta === undefined) return
    yield { type: 'text-delta', index: indexFor(blocks, 'text', data.ordinal ?? 0), text: data.delta }
    return
  }

  if (type === TEXT_ENDED) {
    yield {
      type: 'block-end',
      index: indexFor(blocks, 'text', data.ordinal ?? 0),
      block: { type: 'text', text: data.text ?? '' },
    }
    blocks.indexes.delete(`text:${data.ordinal ?? 0}`)
    return
  }

  if (REASONING_STARTED.includes(type)) {
    yield { type: 'block-start', index: indexFor(blocks, 'reasoning', data.ordinal ?? 0), blockType: 'reasoning' }
    return
  }

  if (REASONING_DELTA.includes(type)) {
    if (data.delta === undefined) return
    yield { type: 'reasoning-delta', index: indexFor(blocks, 'reasoning', data.ordinal ?? 0), text: data.delta }
    return
  }

  if (REASONING_ENDED.includes(type)) {
    yield {
      type: 'block-end',
      index: indexFor(blocks, 'reasoning', data.ordinal ?? 0),
      block: { type: 'reasoning', text: data.text ?? '' },
    }
    blocks.indexes.delete(`reasoning:${data.ordinal ?? 0}`)
    return
  }

  if (type === STEP_ENDED) {
    if (data.tokens !== undefined) {
      const step = toUsage(data.tokens)
      blocks.usage ??= { inputTokens: 0, outputTokens: 0 }
      for (const key of Object.keys(step) as (keyof typeof step)[]) {
        blocks.usage[key] = (blocks.usage[key] ?? 0) + (step[key] ?? 0)
      }
    }
    const reason = toFinishReason(data.finish, data.rawFinish)
    if (reason.kind !== 'tool-calls') blocks.finish = reason
    return
  }

  if (EXECUTION_FAILED.includes(type) || type === 'session.execution.interrupted') {
    const message = typeof data.message === 'string' ? data.message : JSON.stringify(data.error ?? 'OpenCode reported a failed execution')
    if (blocks.usage !== undefined) yield { type: 'usage', usage: blocks.usage }
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message, code: type === 'session.execution.interrupted' ? 'ABORTED' : 'PROVIDER' } },
    }
    return
  }

  if (type === EXECUTION_SUCCEEDED) {
    if (blocks.usage === undefined) throw new LlmError('OpenCode ended the turn without token usage', 'PROTOCOL')
    yield { type: 'usage', usage: blocks.usage }
    yield { type: 'finish', reason: blocks.finish }
    return
  }

  // Any other event is auxiliary: ignoring it costs observability, not the turn.
}

/**
 * Converts OpenCode's token counters to the harness vocabulary.
 *
 * `input` is already disjoint from cache reads, so it maps straight onto
 * `inputTokens`; cache reads and writes are reported separately, which is what
 * makes a cache hit visible as a saving rather than as free input.
 */
function toUsage(tokens: NonNullable<NonNullable<OpenCodeEvent['data']>['tokens']>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  totalTokens?: number
} {
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  const cacheRead = tokens.cache?.read
  const cacheWrite = tokens.cache?.write
  const reasoning = tokens.reasoning
  const usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  } = { inputTokens: input, outputTokens: output }
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined && reasoning > 0) usage.reasoningTokens = reasoning
  // Billed input plus output, excluding the free tier's zero cost.
  usage.totalTokens = input + output + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return usage
}

/** Maps a provider finish string onto the harness finish reasons. */
function toFinishReason(finish: string | undefined, rawFinish: string | undefined): { kind: 'stop' } | { kind: 'max-tokens' } | { kind: 'tool-calls' } {
  const value = (rawFinish ?? finish ?? '').toLowerCase()
  if (value === 'length' || value === 'max_tokens' || value === 'max-tokens') return { kind: 'max-tokens' }
  if (value === 'tool_calls' || value === 'tool-calls') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Translates a fixed event sequence into stream chunks.
 *
 * Exposed so the block-indexing rules can be exercised against a known event
 * order, including a reasoning block followed by a text block that both number
 * themselves from zero. That collision is the one a live model reproduces only
 * intermittently, and when it happened it silently dropped a turn's whole
 * answer while leaving the thinking visible.
 *
 * @param events - provider events in the order the server published them
 * @returns the equivalent harness stream chunks
 */
export function translateEvents(events: readonly OpenCodeEvent[]): StreamChunk[] {
  const blocks = freshBlocks()
  const chunks: StreamChunk[] = []
  for (const event of events) {
    for (const chunk of translate(event, blocks)) chunks.push(chunk)
  }
  return chunks
}

/** Normalises a client failure onto the harness error taxonomy. */
function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof OpenCodeRequestError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  return new LlmError(error instanceof Error ? error.message : String(error), 'TRANSPORT')
}


export interface OpenCodeEventContext {
  harnessSessionId: Branded<'SessionId'> | undefined
  providerSessionId: string
  event: OpenCodeEvent
  signal: AbortSignal
}

/** Optional plugin boundary for native progress and interactive agent requests. */
export interface OpenCodeIntegration {
  toolBridge?: HarnessToolBridge
  bridgeHarnessTools?: boolean
  agent?: string
  permissions?: readonly PermissionRule[]
  onEvent?: (context: OpenCodeEventContext) => void | Promise<void>
  onPermission?: (context: OpenCodeEventContext) => 'once' | 'always' | 'reject' | undefined | Promise<'once' | 'always' | 'reject' | undefined>
  onForm?: (context: OpenCodeEventContext) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
}
