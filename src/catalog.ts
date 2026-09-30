/**
 * Model catalogue for the `opencode-free` route.
 *
 * The list is read from the running `opencode serve` rather than pinned here, so
 * a free model OpenCode adds appears without a plugin update and one it retires
 * disappears the same way. Only models the server reports under the `opencode`
 * provider AND with a zero input cost are offered: those are the ones the free
 * tier actually serves, and they are the ones a direct client cannot reach.
 */
import type { LlmModelInfo, LlmModelContext, ModelModality } from '@deepseek-ai/dsh-llm'
import type { OpenCodeModelEntry } from './wire.ts'

/** Provider id the free models are listed under. */
export const OPENCODE_PROVIDER = 'opencode'

/** One discovered free model, with the metadata the harness needs. */
export interface FreeModel extends LlmModelInfo {
  context?: LlmModelContext
  tools: boolean
}

/** Whether one catalogue entry is a free model this route should serve. */
export function isFreeModel(entry: OpenCodeModelEntry): boolean {
  if (entry.providerID !== OPENCODE_PROVIDER) return false
  const cost = entry.cost?.[0]
  // An absent cost is unknown, not free: never offer a model whose price cannot
  // be confirmed, because a paid request through a free route is a real charge.
  return cost !== undefined && (cost.input ?? 1) === 0
}

/** Projects one catalogue entry onto the route's model description. */
export function toFreeModel(entry: OpenCodeModelEntry): FreeModel {
  const context = entry.limit?.context
  return {
    provider: OPENCODE_PROVIDER,
    id: entry.id,
    name: entry.name ?? entry.id,
    inputModalities: readModalities(entry),
    context: context === undefined ? undefined : { contextWindow: context },
    tools: entry.capabilities?.tools === true,
  }
}

/** Maps OpenCode's input modality strings onto the harness vocabulary. */
function readModalities(entry: OpenCodeModelEntry): ModelModality[] | undefined {
  const input = entry.capabilities?.input
  if (input === undefined) return undefined
  const modalities: ModelModality[] = []
  for (const value of input) {
    if (value === 'text') modalities.push('text')
    // Only text and image are harness modalities; a video or pdf capability is
    // not representable, so the route stays text-and-image.
    if (value === 'image') modalities.push('image')
  }
  return modalities.length > 0 ? modalities : undefined
}

/** One discovered free model, or `undefined` when the id is not in the catalogue. */
export function findModel(entries: readonly OpenCodeModelEntry[], id: string): OpenCodeModelEntry | undefined {
  return entries.find((entry) => entry.id === id && isFreeModel(entry))
}
