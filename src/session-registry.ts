/**
 * Maps one dsh session onto one long-lived OpenCode session.
 *
 * Delegating a whole conversation requires the provider side to keep the
 * conversation. Creating an OpenCode session per request throws that away: the
 * model cannot recall an earlier turn, and every turn re-sends the whole
 * transcript as flattened text because it has to. This registry holds the
 * mapping instead, so a follow-up turn is a single new message.
 *
 * Three problems come with holding state, and each is answered here:
 *
 * - **Which messages are new.** The harness hands over the whole derived
 *   history every turn, so the cursor remembers the last message already sent
 *   and only what follows it is new. The cursor is anchored on the last sent
 *   message id rather than a count, because compaction and forks rewrite a
 *   prefix and would silently shift a count.
 * - **Concurrent turns.** Two turns on one session would race the cursor, so
 *   every mutation is serialised through one per-session queue.
 * - **Leaked provider sessions.** OpenCode writes each session to disk and
 *   nothing removes it but this registry, so entries are bounded by count and
 *   reclaimed when idle or when the plugin unloads.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { OpenCodeClient } from './client.ts'

/** Message identity as the harness surfaces it. */
type MessageId = string

/** How long an untouched entry survives before its provider session is reclaimed. */
export interface RegistryPolicy {
  /** Maximum entries retained; the least recently used is reclaimed beyond it. */
  maxSessions: number
  /** Idle lifetime of an entry in milliseconds; `0` disables idle reclamation. */
  idleTtlMs: number
  /** Lifetime of an in-flight turn's reclaim protection. */
  turnGraceMs: number
}

/** One mapped session and the cursor describing what has already been sent. */
interface Entry {
  opencodeSessionId: string
  /** Identity of the last message already handed to OpenCode. */
  sentThrough: MessageId | undefined
  /** How many entries have been sent, for the divergence check. */
  sentCount: number
  /** Whether the system prompt and capability list have been sent already. */
  preambleSent: boolean
  lastUsed: number
  /** Serialises turns; one in-flight turn per session. */
  queue: Promise<unknown>
}

const DEFAULTS: RegistryPolicy = { maxSessions: 32, idleTtlMs: 30 * 60_000, turnGraceMs: 10 * 60_000 }

/** One message's identity, role and text, as this registry needs it. */
export interface DigestMessage {
  id: MessageId | undefined
  /** Who said it. Kept because a conversation may hold consecutive user turns. */
  role: 'user' | 'assistant'
  text: string
}

/** Flattens one harness message's content blocks to text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

/** The two roles OpenCode can be told about; everything else is not conversation. */
function isConversible(message: GenerateOptions['messages'][number]): message is GenerateOptions['messages'][number] & { role: 'user' | 'assistant' } {
  // Tool results are OpenCode's own concern: it ran the tools, so replaying
  // harness tool results would describe work it already did.
  return message.role === 'user' || message.role === 'assistant'
}

/** Projects a request's messages into identity, role and text. */
export function digest(options: GenerateOptions): DigestMessage[] {
  const messages: DigestMessage[] = []
  for (const message of options.messages) {
    if (!isConversible(message)) continue
    messages.push({ id: message.id, role: message.role, text: textOf(message.content) })
  }
  return messages
}

/**
 * What one turn should send, given what a session already sent.
 *
 * `resendAll` is the divergence signal: the anchor is gone or has moved, which
 * means the harness rewrote the prefix, so nothing can be sent as a delta and
 * the whole conversation must be replayed.
 */
export interface TurnPlan {
  /** Messages to send, in order. */
  messages: readonly DigestMessage[]
  /** Whether to send the system prompt and capability list with this turn. */
  sendPreamble: boolean
  /** Whether the provider session must be rebuilt from scratch. */
  resendAll: boolean
}

/**
 * Decides what a turn sends.
 *
 * The cursor holds the id of the last message already sent. When that id is
 * still in the history, the messages after it are the delta. When it is not,
 * the prefix was rewritten and the whole history is replayed instead, which is
 * the safe answer: it is the current behaviour, so a divergence costs continuity
 * rather than a failed turn.
 *
 * @param messages - the request's messages in derived order
 * @param sentThrough - identity of the last message already sent, if any
 * @param preambleSent - whether the preamble has already gone to this session
 * @returns the messages to send and whether the session must be rebuilt
 */
export function planTurn(
  messages: readonly DigestMessage[],
  sentThrough: MessageId | undefined,
  preambleSent: boolean,
): TurnPlan {
  if (sentThrough === undefined) {
    return { messages, sendPreamble: !preambleSent, resendAll: true }
  }
  const anchor = messages.findIndex((message) => message.id === sentThrough)
  if (anchor === -1) {
    // The anchor was rewritten away: replay everything into a fresh session.
    return { messages, sendPreamble: !preambleSent, resendAll: true }
  }
  const delta = messages.slice(anchor + 1).filter((message) => message.text.length > 0)
  if (delta.length === 0) {
    // A retried or repeated turn carries nothing new; the provider session
    // already holds this exchange, so there is nothing to add.
    return { messages: [], sendPreamble: false, resendAll: false }
  }
  return { messages: delta, sendPreamble: !preambleSent, resendAll: false }
}

/** Owns the dsh-to-OpenCode session mapping and its reclamation. */
export class SessionRegistry {
  readonly #entries = new Map<Branded<'SessionId'>, Entry>()
  readonly #policy: RegistryPolicy

  constructor(policy: Partial<RegistryPolicy> = {}) {
    this.#policy = { ...DEFAULTS, ...policy }
  }

  /** Entries currently held, for diagnostics. */
  get size(): number {
    return this.#entries.size
  }

  /** The provider session currently mapped, if any. */
  providerSession(sessionId: Branded<'SessionId'>): string | undefined {
    return this.#entries.get(sessionId)?.opencodeSessionId
  }

  /**
   * Runs one turn's mutations in order against a session's entry.
   *
   * Serialising here is what keeps two concurrent turns from reading the same
   * cursor and sending the same delta twice.
   *
   * @param sessionId - the harness session the turn belongs to
   * @param task - the work to run; receives the current entry state
   * @returns whatever `task` returns
   */
  async withEntry<T>(
    sessionId: Branded<'SessionId'>,
    task: (state: { entry: Entry; opencodeSessionId: string }) => Promise<T>,
  ): Promise<T> {
    const previous = this.#entries.get(sessionId)?.queue ?? Promise.resolve()
    // A failed turn must not reject the queue, or the next turn inherits the
    // error instead of running.
    const run = previous.then(
      () => this.#runEntry(sessionId, task),
      () => this.#runEntry(sessionId, task),
    )
    const existing = this.#entries.get(sessionId) ?? this.#insertPlaceholder(sessionId)
    existing.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /** Runs `task` with the live entry, creating one on first use. */
  async #runEntry<T>(
    sessionId: Branded<'SessionId'>,
    task: (state: { entry: Entry; opencodeSessionId: string }) => Promise<T>,
  ): Promise<T> {
    const entry = this.#entries.get(sessionId) ?? this.#insertPlaceholder(sessionId)
    entry.lastUsed = Date.now()
    const result = await task({ entry, opencodeSessionId: entry.opencodeSessionId })
    entry.lastUsed = Date.now()
    return result
  }

  /** Stores a minimal entry so a queue exists before the first real turn. */
  #insertPlaceholder(sessionId: Branded<'SessionId'>): Entry {
    const entry = this.#placeholder()
    this.#entries.set(sessionId, entry)
    return entry
  }

  /** Builds a minimal entry: no provider session yet, nothing sent. */
  #placeholder(): Entry {
    return {
      opencodeSessionId: '',
      sentThrough: undefined,
      sentCount: 0,
      preambleSent: false,
      lastUsed: Date.now(),
      queue: Promise.resolve(),
    }
  }

  /**
   * Records a freshly created provider session for a harness session.
   *
   * The count bound is enforced here rather than only on a periodic sweep, so
   * the registry cannot exceed `maxSessions` between sweeps.
   *
   * @returns provider sessions evicted to make room, for the caller to delete
   */
  async adopt(sessionId: Branded<'SessionId'>, opencodeSessionId: string): Promise<string[]> {
    await this.withEntry(sessionId, async ({ entry }) => {
      entry.opencodeSessionId = opencodeSessionId
      entry.sentThrough = undefined
      entry.sentCount = 0
      entry.preambleSent = false
    })
    // Only the count bound applies: an entry adopted moments ago is fresh, so
    // idle reclamation has nothing to say about it.
    return this.#enforceCountBound()
  }

  /** Drops least-recently-used entries past the count bound. */
  #enforceCountBound(): string[] {
    const evicted: string[] = []
    if (this.#entries.size <= this.#policy.maxSessions) return evicted
    const byAge = [...this.#entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [sessionId, entry] of byAge.slice(0, this.#entries.size - this.#policy.maxSessions)) {
      if (entry.opencodeSessionId !== '') evicted.push(entry.opencodeSessionId)
      this.#entries.delete(sessionId)
    }
    return evicted
  }

  /** Records how much of the conversation the provider session now holds. */
  async advance(sessionId: Branded<'SessionId'>, plan: TurnPlan): Promise<void> {
    await this.withEntry(sessionId, async ({ entry }) => {
      const last = plan.messages.at(-1)
      if (last?.id !== undefined) entry.sentThrough = last.id
      entry.sentCount += plan.messages.length
      if (plan.sendPreamble) entry.preambleSent = true
    })
  }

  /** Marks a provider session unusable, so the next turn creates a fresh one. */
  async invalidate(sessionId: Branded<'SessionId'>): Promise<void> {
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return
    entry.opencodeSessionId = ''
    entry.sentThrough = undefined
    entry.sentCount = 0
    entry.preambleSent = false
  }

  /** Drops one harness session and returns its provider session for deletion. */
  async release(sessionId: Branded<'SessionId'>): Promise<string | undefined> {
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return undefined
    this.#entries.delete(sessionId)
    return entry.opencodeSessionId === '' ? undefined : entry.opencodeSessionId
  }

  /**
   * Reclaims entries past the count bound or idle past the TTL.
   *
   * An entry mid-turn is protected by `turnGraceMs` from the last touch, so
   * reclamation cannot delete a provider session a running turn is using.
   *
   * @returns the provider sessions to delete, for the caller to remove
   */
  async reclaim(now = Date.now()): Promise<string[]> {
    const expired: string[] = []
    for (const [sessionId, entry] of this.#entries) {
      // A turn in flight is protected from the start of the grace window, so a
      // sweep cannot delete the provider session a running turn is using.
      if (now - entry.lastUsed < this.#policy.turnGraceMs) continue
      if (this.#policy.idleTtlMs > 0 && now - entry.lastUsed < this.#policy.idleTtlMs) continue
      if (entry.opencodeSessionId !== '') expired.push(entry.opencodeSessionId)
      this.#entries.delete(sessionId)
    }
    expired.push(...this.#enforceCountBound())
    return expired
  }

  /** Every provider session currently held, for shutdown. */
  all(): string[] {
    return [...this.#entries.values()].map((entry) => entry.opencodeSessionId).filter((id) => id !== '')
  }
}

/** The client operations this registry needs, so it can be exercised without a server. */
export type RegistryClient = Pick<OpenCodeClient, 'deleteSession'>

/** Deletes provider sessions the registry no longer owns. */
export async function deleteReclaimed(client: RegistryClient, ids: readonly string[]): Promise<void> {
  for (const id of ids) await client.deleteSession(id)
}
