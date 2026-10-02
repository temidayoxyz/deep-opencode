/**
 * Model catalogue for the `opencode-free` route.
 *
 * The list is read from the running `opencode serve` rather than pinned here, so
 * a free model OpenCode adds appears without a plugin update and one it retires
 * disappears the same way. Only models the server reports under the `opencode`
 * provider AND with a zero input cost are offered: those are the ones the free
 * tier actually serves, and they are the ones a direct client cannot reach.
 */
import type { LlmModelInfo, LlmModelContext } from '@deepseek-ai/dsh-llm'
import type { OpenCodeModelEntry } from './wire.ts'

/**
 * The provider id OpenCode's own API lists the free models under.
 *
 * This is sent to `opencode serve` when a session's model is selected, and it
 * is deliberately not the route name: `opencode` is also a provider in the
 * shared models.dev catalogue that the harness already registers, so reusing it
 * as a route would collide.
 */
export const OPENCODE_PROVIDER = 'opencode'

/**
 * The provider route this plugin registers on `ctx.llm`.
 *
 * Model metadata the harness validates must carry this exact value as its
 * `provider`; `OPENCODE_PROVIDER` is only ever sent over the wire.
 */
export const OPENCODE_FREE_ROUTE = 'opencode-free'

/** One discovered free model, with the metadata the harness needs. */
export interface FreeModel extends LlmModelInfo {
  context?: LlmModelContext
  tools: boolean
}

/** Whether one catalogue entry is a free model this route should serve. */
export function isFreeModel(entry: OpenCodeModelEntry): boolean {
  if (entry.providerID !== OPENCODE_PROVIDER) return false
  // An absent cost is unknown, not free: never offer a model whose price cannot
  // be confirmed, because a paid request through a free route is a real charge.
  return entry.cost !== undefined && entry.cost.length > 0 && entry.cost.every((cost) =>
    cost.input === 0 && cost.output === 0 && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0)
}

/** Projects one catalogue entry onto the route's model description. */
export function toFreeModel(entry: OpenCodeModelEntry): FreeModel {
  const context = entry.limit?.context
  return {
    // The harness validates that advertised metadata names the route it is
    // registered under, so this is the route rather than OpenCode's provider id.
    provider: OPENCODE_FREE_ROUTE,
    id: entry.id,
    name: entry.name ?? entry.id,
    // This adapter forwards text only, even when the native model accepts images.
    inputModalities: ['text'],
    context: context === undefined ? undefined : { contextWindow: context },
    tools: entry.capabilities?.tools === true,
  }
}

/** One discovered free model, or `undefined` when the id is not in the catalogue. */
export function findModel(entries: readonly OpenCodeModelEntry[], id: string): OpenCodeModelEntry | undefined {
  return entries.find((entry) => entry.id === id && isFreeModel(entry))
}
