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
 * emitted after `finish`, block indexes follow the provider's first-seen
 * `ordinal`, and failures end the stream in a terminal `finish` rather than
 * throwing mid-stream.
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
import { OpenCodeClient, OpenCodeRequestError } from './client.ts'
import { OpenCodeServer, OpenCodeServerPool } from './server.ts'
import { OPENCODE_PROVIDER, type FreeModel } from './catalog.ts'
import { refreshCatalog } from './discovery.ts'
import { buildDeltaPrompt, buildTranscriptPrompt } from './prompt.ts'
import { digest, planTurn, type SessionRegistry } from './session-registry.ts'
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
 * Bounds one queue drain.
 *
 * The provider owns the turn, so a turn that never settles would hold the dsh
 * step open indefinitely. A non-positive `timeoutMs` disables the bound.
 */
async function* withTimeout<T>(queue: AsyncQueue<T>, timeoutMs: number): AsyncGenerator<T> {
  if (timeoutMs <= 0) {
    yield* queue
    return
  }
  const iterator = queue[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new LlmError(`opencode-free turn did not settle within ${timeoutMs}ms`, 'TIMEOUT'))
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), expiry])
      if (result.done === true) return
      yield result.value
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Block indexes for one assistant message.
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
}

function freshBlocks(): BlockState {
  return { next: 0, indexes: new Map(), assistantMessageID: undefined }
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

  constructor(
    pool: OpenCodeServerPool,
    fallbackDirectory: string,
    resolveDirectory: DirectoryResolver,
    turnTimeoutMs: number,
    catalogTimeoutMs: number,
    registry?: SessionRegistry,
    reuseSessions = true,
  ) {
    super()
    this.#pool = pool
    this.#fallbackDirectory = fallbackDirectory
    this.#resolveDirectory = resolveDirectory
    this.#registry = registry
    this.#reuseSessions = reuseSessions
    this.#turnTimeoutMs = turnTimeoutMs
    this.#catalogTimeoutMs = catalogTimeoutMs
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
    try {
      return await refreshCatalog(this.#clientFor(undefined), this.#catalogTimeoutMs)
    } catch {
      return []
    }
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
   * because OpenCode fixes a session's directory when its process starts.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const conversation = digest(options)
    const client = this.#clientFor(options.sessionId)

    // A session id is what makes the conversation mappable. Without one there is
    // nothing to key on, so the turn is a one-shot transcript.
    const mapped = options.sessionId !== undefined && this.#reuseSessions
    const registry = this.#registry
    const run = async (): Promise<{ providerSessionId: string; text: string }> => {
      const digestOf = conversation
      if (!mapped || registry === undefined) {
        const text = buildTranscriptPrompt(options, digestOf)
        if (text.length === 0) throw new LlmError('opencode-free received a request with no text to send', 'INVALID_REQUEST')
        const created = await client.createSession()
        await client.setModel(created, options.model, OPENCODE_PROVIDER)
        return { providerSessionId: created, text }
      }
      return await registry.withEntry(options.sessionId as Branded<'SessionId'>, async ({ entry, opencodeSessionId }) => {
        const plan = planTurn(digestOf, entry.sentThrough, entry.preambleSent)
        let providerSessionId = opencodeSessionId
        if (providerSessionId === '' || plan.resendAll) {
          // Either nothing was mapped, or the cursor lost its anchor because the
          // harness rewrote the prefix. A fresh provider session is the safe
          // answer: the whole conversation is replayed into it.
          const previous = providerSessionId
          providerSessionId = await client.createSession()
          await client.setModel(providerSessionId, options.model, OPENCODE_PROVIDER)
          entry.opencodeSessionId = providerSessionId
          entry.sentThrough = undefined
          entry.sentCount = 0
          entry.preambleSent = false
          if (previous !== '') await client.deleteSession(previous)
        }
        const text = plan.resendAll || plan.messages.length === 0
          ? buildTranscriptPrompt(options, digestOf)
          : buildDeltaPrompt(options, plan.messages, plan.sendPreamble)
        if (text.length === 0) {
          throw new LlmError('opencode-free received a request with no text to send', 'INVALID_REQUEST')
        }
        // The cursor is recorded here rather than after the prompt succeeds:
        // calling back into the registry from inside its own queue would wait on
        // this turn. A prompt that fails leaves the cursor advanced, which costs
        // one replayed message on the next turn rather than a lost turn.
        const last = plan.messages.at(-1)
        if (last?.id !== undefined) entry.sentThrough = last.id
        entry.sentCount += plan.messages.length
        if (plan.sendPreamble) entry.preambleSent = true
        return { providerSessionId, text }
      })
    }

    let prepared: { providerSessionId: string; text: string }
    try {
      prepared = await run()
    } catch (error) {
      throw toLlmError(error)
    }

    const text = prepared.text
    const sessionId = prepared.providerSessionId
    const blocks = freshBlocks()
    let usageEmitted = false
    let finished = false

    try {
      // The provider's deltas are transient: one published before this adapter
      // subscribes is not replayed, so the subscription must be ESTABLISHED, not
      // merely created, before the prompt goes out. `events()` is lazy, so the
      // first frame is awaited here; it is the server's own connected notice and
      // is not part of any turn.
      //
      // The subscription is shared with the caller's signal and with a local
      // controller, so aborting either ends the reader: the server keeps the
      // stream open indefinitely, and the turn is over at the first `finish`.
      const queue = new AsyncQueue<StreamChunk>()
      const subscription = new AbortController()
      const onCallerAbort = (): void => {
        subscription.abort()
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) subscription.abort()
        else options.signal.addEventListener('abort', onCallerAbort, { once: true })
      }

      const reader = client.events(subscription.signal)[Symbol.asyncIterator]()
      let pending = reader.next()

      /** Drains one frame's chunks into the queue. */
      const consume = (event: OpenCodeEvent): void => {
        // Only this session's frames belong to this request; a shared server
        // also reports other sessions' activity, including a mapped session's
        // earlier turns.
        if (event.data?.sessionID !== undefined && event.data.sessionID !== sessionId) return
        for (const chunk of translate(event, blocks)) {
          if (chunk.type === 'usage') usageEmitted = true
          if (chunk.type === 'finish') finished = true
          queue.push(chunk)
        }
      }

      try {
        // Opening the subscription before prompting is what makes the turn's own
        // output observable; without it the answer can arrive before the reader
        // is attached and be lost.
        const opened = await pending
        if (opened.done !== true) consume(opened.value)
        await client.prompt(sessionId, text)

        // The reader runs as its own task and hands frames over the queue, so
        // this generator stays the only source of yields.
        pending = reader.next()
        const pump = (async () => {
          try {
            while (!finished) {
              const step = await pending
              if (step.done === true) break
              consume(step.value)
              pending = reader.next()
            }
          } catch (error) {
            // An abort is the normal end of a completed turn, not a failure.
            if (!subscription.signal.aborted) queue.fail(toLlmError(error))
          } finally {
            queue.close()
          }
        })()

        // The provider owns the turn, so a turn that never settles is bounded
        // here; an unbounded wait would hold the dsh step open indefinitely.
        for await (const chunk of withTimeout(queue, this.#turnTimeoutMs)) {
          yield chunk
          if (chunk.type === 'finish') break
        }
      } finally {
        // The turn is settled or abandoned, so the subscription ends here;
        // otherwise the reader would outlive this generator and hang the task.
        subscription.abort()
        options.signal?.removeEventListener('abort', onCallerAbort)
        await reader.return?.(undefined)
      }
    } catch (error) {
      // A transport or protocol failure ends the stream terminally; consumers
      // route on the code, never on the message.
      throw toLlmError(error)
    } finally {
      // A mapped provider session is the conversation and must survive the turn.
      // An unmapped one was created for this request alone and is removed.
      if (!mapped) await client.deleteSession(sessionId)
    }

    if (!finished) {
      throw new LlmError('OpenCode ended the turn without a terminal event', 'PROTOCOL')
    }
    if (!usageEmitted) {
      // Usage is not optional: the token meter and cost accounting read it, and
      // a turn that reports none would silently read as free.
      throw new LlmError('OpenCode ended the turn without token usage', 'PROTOCOL')
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
    // A new assistant message means a fresh set of provider block ordinals.
    if (blocks.assistantMessageID !== data.assistantMessageID) {
      blocks.next = 0
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
    // Usage must precede finish, and nothing may follow the terminal chunk.
    if (data.tokens !== undefined) {
      yield { type: 'usage', usage: toUsage(data.tokens) }
    }
    yield { type: 'finish', reason: toFinishReason(data.finish, data.rawFinish) }
    return
  }

  if (EXECUTION_FAILED.includes(type)) {
    const message = typeof data.message === 'string' ? data.message : 'OpenCode reported a failed execution'
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message, code: 'PROVIDER' } },
    }
    return
  }

  if (type === EXECUTION_SUCCEEDED) {
    // The step that owns the terminal finish is authoritative; a bare execution
    // success after it must not append a second finish.
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
