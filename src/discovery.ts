/**
 * The route's discovered model catalogue.
 *
 * The list is read from the running `opencode serve` rather than pinned here, so
 * a free model OpenCode adds appears without a plugin update and one it retires
 * disappears the same way. Only models the server reports under the `opencode`
 * provider AND with a zero input cost are offered: those are the ones the free
 * tier actually serves, and the ones a direct client cannot reach.
 *
 * This module owns the cache so both the adapter's `listModels` and the plugin's
 * load-time diagnostics read the same read, without the two importing each
 * other.
 */
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { isFreeModel, toFreeModel, type FreeModel } from './catalog.ts'
import type { OpenCodeClient } from './client.ts'

/** The models this route currently offers. */
let cached: FreeModel[] = []
let generation = 0

/**
 * How long to keep asking a server that reports an empty catalogue.
 *
 * OpenCode fetches its provider list after it starts listening, so the first
 * answers are empty while that fetch is in flight.
 */
const CATALOG_TIMEOUT_MS = 60_000

/** Gap between those retries. */
const CATALOG_POLL_INTERVAL_MS = 1_500

/** The models the GUI model picker offers for this route. */
export function listModels(): FreeModel[] {
  return cached
}

/**
 * Reads the free models from the running server and replaces the catalogue.
 *
 * A model OpenCode adds appears here; one it retires disappears on the next
 * read. The read is deliberately uncached, because the catalogue is the thing
 * that tracks OpenCode's own churn.
 *
 * A freshly started server answers with an empty catalogue until it finishes
 * fetching the provider list, which is seconds rather than milliseconds, so an
 * empty answer is retried until `timeoutMs` elapses. Reading once would report
 * no models on every first load and leave the route unselectable.
 */
export async function refreshCatalog(client: OpenCodeClient, timeoutMs = CATALOG_TIMEOUT_MS): Promise<FreeModel[]> {
  const startedGeneration = generation
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  for (;;) {
    const entries = await client.listModels()
    if (startedGeneration !== generation) return []
    if (entries.length > 0) {
      cached = entries.filter(isFreeModel).map(toFreeModel)
      return cached
    }
    if (Date.now() >= deadline) {
      // A read that timed out must not discard a catalogue that already worked.
      // OpenCode fetches its provider list lazily, so a server that is busy or
      // still starting answers empty; overwriting a good list with that empty
      // answer is what leaves the model picker showing nothing at all.
      if (cached.length > 0) return cached
      cached = []
      return cached
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, CATALOG_POLL_INTERVAL_MS)
      timer.unref?.()
    })
  }
}

/** The discovered catalogue as the plain model list the harness expects. */
export function listModelInfo(): readonly LlmModelInfo[] {
  return cached
}

/** Empties the catalogue, called when the route is released. */
export function clearCatalog(): void {
  generation++
  cached = []
}
