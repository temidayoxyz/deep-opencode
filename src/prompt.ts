/**
 * Turns one delegated turn into the text OpenCode receives.
 *
 * Two shapes, because there are two situations. When a conversation is already
 * mapped to a provider session, only what is new is sent. The transcript
 * preamble goes once at the start: OpenCode keeps the conversation itself.
 * The native companion supplies scoped DSH context separately on each request.
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
 * The default preamble gives the working directory and native capabilities.
 * The bridge's context hook supplies the Harness system prompt and DSH tool
 * schemas separately, so tool availability stays scoped to the active step.
 *
 * It is not repeated per turn: the provider applies it once and keeps it, so
 * resending would accumulate duplicates in its own context.
 *
 * @param options - the assembled request
 * @param context - the working directory for the turn, and whether to forward
 *   the harness prompt and tool list verbatim
 * @returns the preamble text, empty when there is nothing to declare
 */
export function buildPreamble(options: GenerateOptions, context: PreambleContext): string {
  if (context.forwardHarnessContext) {
    // Legacy opt-in for also embedding Harness context in the transcript.
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
  if (context.workingDirectory === undefined) return ''
  return (
    `You are working in ${context.workingDirectory}. ` +
    'You have your own tools for reading and writing files, running shell commands and searching ' +
    'the project. Use them when the user asks for work that requires them. ' +
    'Do not describe steps you are not going to take, and do not ask for tools you were not given.'
  )
}

/** What the preamble is allowed to say about the turn it opens. */
export type PreambleContext = {
  /** The project directory the turn runs in, when one is known. */
  workingDirectory: string | undefined
  /**
   * Whether to embed Harness context in the transcript preamble as well as
   * any context supplied by the native companion. Off by default.
   */
  forwardHarnessContext: boolean
}

/**
 * The single instruction sent when there is no mapped provider session.
 *
 * The conversation is flattened into one labelled transcript rather than sent
 * as structured history, because OpenCode's prompt endpoint accepts one text
 * field and runs its own agent turn on top of it.
 *
 * @param options - the assembled request
 * @param context - what the preamble may say about this turn
 * @param messages - the conversation to include, in order
 * @returns the prompt text, empty when nothing is worth sending
 */
export function buildTranscriptPrompt(
  options: GenerateOptions,
  context: PreambleContext,
  messages: readonly DigestMessage[],
): string {
  const sections: string[] = []
  const preamble = buildPreamble(options, context)
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
 * @param context - what the preamble may say about this turn
 * @param messages - only what is new since the last turn
 * @param includePreamble - whether this turn also opens the conversation
 * @returns the prompt text, empty when there is nothing new to say
 */
export function buildDeltaPrompt(
  options: GenerateOptions,
  context: PreambleContext,
  messages: readonly DigestMessage[],
  includePreamble: boolean,
): string {
  const parts: string[] = []
  if (includePreamble) {
    const preamble = buildPreamble(options, context)
    if (preamble.length > 0) parts.push(preamble)
  }
  for (const message of messages) {
    if (message.text.length > 0) parts.push(`${label(message.role)}: ${message.text}`)
  }
  return parts.join('\n\n')
}
