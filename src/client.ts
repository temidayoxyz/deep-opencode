/**
 * HTTP client for the OpenCode v2 API surface this adapter uses.
 *
 * The base URL, session endpoints and event stream were read from a live
 * v2.0.18 server's `GET /openapi.json` and observed on the wire. No path or
 * payload shape is version-gated: `capabilities()` reports what the server
 * exposes so drift is visible in diagnostics instead of failing silently.
 */
import { authorizationHeader, type OpenCodeServer } from './server.ts'
import type { OpenCodeEvent, OpenCodeModelEntry, OpenCodeModelList, OpenCodeServerInfo } from './wire.ts'

/** Routes the adapter uses, named for the `operationId` each answers to. */
export const ROUTES = {
  info: '/api/info',
  modelList: '/api/model',
  sessionCreate: '/api/session',
  sessionDelete: (id: string): string => `/api/session/${id}`,
  sessionModel: (id: string): string => `/api/session/${id}/model`,
  sessionPrompt: (id: string): string => `/api/session/${id}/prompt`,
  sessionInterrupt: (id: string): string => `/api/session/${id}/interrupt`,
  eventSubscribe: '/api/event',
} as const

/** A failure carrying the stable code the harness routes on. */
export class OpenCodeRequestError extends Error {
  readonly status: number | undefined
  readonly code: string

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'OpenCodeRequestError'
    this.code = code
    this.status = status
  }
}

/** Maps a transport or protocol failure onto one of the harness failure codes. */
function classify(status: number | undefined): string {
  if (status === 401) return 'AUTH'
  if (status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 404) return 'NO_ADAPTER'
  if (status !== undefined && status >= 500) return 'PROVIDER'
  return 'TRANSPORT'
}

/** Thin wrapper over the running server's HTTP API. */
export class OpenCodeClient {
  readonly #server: OpenCodeServer

  constructor(server: OpenCodeServer) {
    this.#server = server
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    let baseUrl: string
    let password: string
    try {
      const address = await this.#server.start()
      baseUrl = address.baseUrl
      password = address.password
    } catch (error) {
      throw new OpenCodeRequestError(
        `OpenCode server unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
      )
    }
    return await fetch(baseUrl + path, {
      ...init,
      headers: {
        Authorization: authorizationHeader(password),
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  /** One JSON GET/POST/DELETE, raising `OpenCodeRequestError` on a non-2xx. */
  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, init)
    const text = await response.text()
    if (!response.ok) {
      // OpenCode v2 returns tagged error bodies, and `message` is the useful part.
      let detail = text.slice(0, 400)
      try {
        const parsed = JSON.parse(text) as { message?: string; _tag?: string }
        detail = parsed.message ?? parsed._tag ?? detail
      } catch {
        // A non-JSON body is reported as-is; the status still classifies it.
      }
      throw new OpenCodeRequestError(
        `OpenCode ${init.method ?? 'GET'} ${path} failed (${response.status}): ${detail}`,
        classify(response.status),
        response.status,
      )
    }
    if (text.length === 0) return undefined as T
    const parsed = JSON.parse(text) as { data?: T }
    return (parsed.data ?? parsed) as T
  }

  /** `GET /api/info` — the server's own version, for diagnostics only. */
  async info(): Promise<OpenCodeServerInfo> {
    return await this.#json<OpenCodeServerInfo>(ROUTES.info)
  }

  /**
   * `GET /api/model` — the authoritative catalogue, including the free models.
   *
   * `#json` already unwraps the `data` envelope, so the result is the entry
   * array itself. Both a bare array and an enveloped body are accepted so a
   * server that changes its envelope does not read as an empty catalogue.
   */
  async listModels(): Promise<OpenCodeModelEntry[]> {
    const body = await this.#json<OpenCodeModelEntry[] | OpenCodeModelList>(ROUTES.modelList)
    if (Array.isArray(body)) return body
    return body?.data ?? []
  }

  /** `POST /api/session` — one delegated session per dsh request. */
  async createSession(): Promise<string> {
    const session = await this.#json<{ id?: string }>(ROUTES.sessionCreate, { method: 'POST', body: '{}' })
    if (session?.id === undefined) {
      throw new OpenCodeRequestError('OpenCode created a session without an id', 'PROTOCOL')
    }
    return session.id
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.#json(ROUTES.sessionDelete(id), { method: 'DELETE' })
    } catch {
      // A session the server already reclaimed is not an error for the caller.
    }
  }

  /**
   * `POST /api/session/{id}/model` — pins the session's model.
   *
   * The body is `{model: {id, providerID}}`; the server rejects a flat string
   * and a `modelID` key, so both field names are load-bearing.
   */
  async setModel(id: string, model: string, providerID: string): Promise<void> {
    await this.#json(ROUTES.sessionModel(id), {
      method: 'POST',
      body: JSON.stringify({ model: { id: model, providerID } }),
    })
  }

  /** `POST /api/session/{id}/prompt` — enqueues one turn; output arrives on the event stream. */
  async prompt(id: string, text: string): Promise<void> {
    await this.#json(ROUTES.sessionPrompt(id), {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  }

  /** `POST /api/session/{id}/interrupt` — the cancellation path for an in-flight turn. */
  async interrupt(id: string): Promise<void> {
    try {
      await this.#json(ROUTES.sessionInterrupt(id), { method: 'POST' })
    } catch {
      // An already-idle session has nothing to interrupt.
    }
  }

  /**
   * `GET /api/event` — the server-sent event stream every delegated turn reads.
   *
   * Yields parsed frames until `signal` aborts. A transport failure propagates
   * so the caller can end the turn with a terminal failure rather than hanging.
   */
  async *events(signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    let baseUrl: string
    let password: string
    try {
      const address = await this.#server.start()
      baseUrl = address.baseUrl
      password = address.password
    } catch (error) {
      throw new OpenCodeRequestError(
        `OpenCode server unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
      )
    }

    const response = await fetch(baseUrl + ROUTES.eventSubscribe, {
      headers: { Authorization: authorizationHeader(password), Accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok || response.body === null) {
      throw new OpenCodeRequestError(
        `OpenCode event stream failed (${response.status})`,
        classify(response.status),
        response.status,
      )
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload.length === 0) continue
            try {
              yield JSON.parse(payload) as OpenCodeEvent
            } catch {
              // A frame that is not JSON is not a turn-ending failure.
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
}
