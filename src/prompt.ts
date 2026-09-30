/**
 * Turns one delegated turn into the text OpenCode receives.
 *
 * Two shapes, because there are two situations. When a conversation is already
 * mapped to a provider session, only what is new is sent, and the system
 * prompt and capability list go once at the start: OpenCode keeps the
 * conversation itself, and repeating the preamble each turn would accumulate
 * duplicates in its own context.
 *
 * When there is no mapped session, or the cursor found the history had been
 * rewritten, the whole conversation is sent as one labelled transcript. That is
 * what OpenCode needs to catch up, and it is the behaviour a first turn and a
 * divergent turn both need.
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { DigestMessage } from './session-registry.ts'

/** Labels a transcript entry by who said it. */
function label(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'User' : 'Assistant'
}

/** Flattens one message's content blocks to text; images and files are not forwarded. */
function readText(content: unknown): string {
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

/**
 * The one-time context a provider session is opened with.
 *
 * It is not repeated per turn: the provider applies it once and keeps it, so
 * resending would restate the system prompt and the capability list on every
 * exchange.
 *
 * @param options - the assembled request
 * @returns the preamble text, empty when there is nothing to declare
 */
export function buildPreamble(options: GenerateOptions): string {
  const sections: string[] = []
  if (options.system !== undefined && options.system.length > 0) sections.push(options.system)
  const tools = options.tools ?? []
  if (tools.length > 0) {
    sections.push(
      `Available capabilities: ${tools.map((tool) => tool.name).join(', ')}. ` +
        'Use the tools you have been given rather than describing what you would do.',
    )
  }
  return sections.join('\n\n')
}

/**
 * The single instruction sent when there is no mapped provider session.
 *
 * The conversation is flattened into one labelled transcript rather than sent
 * as structured history, because OpenCode's prompt endpoint accepts one text
 * field and runs its own agent turn on top of it.
 *
 * @param options - the assembled request
 * @param messages - the conversation to include, in order
 * @returns the prompt text, empty when nothing is worth sending
 */
export function buildTranscriptPrompt(options: GenerateOptions, messages: readonly DigestMessage[]): string {
  const sections: string[] = []
  const preamble = buildPreamble(options)
  if (preamble.length > 0) sections.push(preamble)
  const transcript = messages
    .filter((message) => message.text.length > 0)
    .map((message) => `${label(message.role)}: ${message.text}`)
  sections.push(transcript.join('\n\n'))
  return sections.filter((section) => section.length > 0).join('\n\n')
}

/**
 * The single new message sent into an existing provider session.
 *
 * One prompt carries one turn, so when several messages are new they are sent
 * as one labelled block: OpenCode would treat separate prompts as separate user
 * turns, and the harness has already decided these belong to one.
 *
 * @param options - the assembled request
 * @param messages - only what is new since the last turn
 * @param includePreamble - whether this turn also opens the conversation
 * @returns the prompt text, empty when there is nothing new to say
 */
export function buildDeltaPrompt(
  options: GenerateOptions,
  messages: readonly DigestMessage[],
  includePreamble: boolean,
): string {
  const parts: string[] = []
  if (includePreamble) {
    const preamble = buildPreamble(options)
    if (preamble.length > 0) parts.push(preamble)
  }
  for (const message of messages) {
    if (message.text.length > 0) parts.push(message.text)
  }
  return parts.join('\n\n')
}
