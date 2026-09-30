/**
 * Turns the delegated session's text into one `opencode serve` prompt.
 *
 * OpenCode runs a complete agent turn with its own system prompt and tools, so a
 * dsh request is flattened into a single instruction rather than replayed as
 * message history. Replaying history would ask OpenCode to reconstruct a
 * transcript it never saw, and the turn would read as instructions rather than
 * as a conversation.
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Assembles the single prompt text one delegated turn sends. */
export function buildPrompt(options: GenerateOptions): string {
  const sections: string[] = []

  if (options.system !== undefined && options.system.length > 0) {
    sections.push(options.system)
  }

  for (const message of options.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = readText(message.content)
    if (text.length === 0) continue
    // The delegation boundary is an instruction, not a transcript, so each turn
    // is labelled rather than concatenated into an ambiguous block.
    sections.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }

  const tools = options.tools ?? []
  if (tools.length > 0) {
    sections.push(
      `Available capabilities: ${tools.map((tool) => tool.name).join(', ')}. ` +
        'Use the tools you have been given rather than describing what you would do.',
    )
  }

  return sections.join('\n\n')
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

