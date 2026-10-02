/** Human prompts and producer context use separate native OpenCode channels. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export interface ContextMessage { role: 'user' | 'assistant' | 'system'; text: string }
/** History absent from native storage, inserted before its stable prompt ID. */
export interface ContextReplay {
  before: string
  messages: readonly ContextMessage[]
  /** Shared with the registry so successful native compaction retires replay. */
  compacted?: boolean
}
export interface TurnContext {
  before: string
  replay: readonly ContextReplay[]
  messages: readonly ContextMessage[]
}

export function readText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

/** Source, rather than text patterns, distinguishes typed text from injections. */
export function isHuman(message: GenerateOptions['messages'][number]): boolean {
  return message.role === 'user' && (message.source === undefined || message.source.kind === 'user')
}

/** Preserve producer context's original privilege level, including literal tags. */
export function contextMessages(options: GenerateOptions): ContextMessage[] {
  return options.messages.filter(message => !isHuman(message) && message.role !== 'assistant' && message.source?.kind !== 'tool')
    .map(message => ({ role: message.role === 'system' ? 'system' as const : 'user' as const, text: readText(message.content) }))
    .filter(message => message.text.length > 0)
}

/** Model instructions are never concatenated into a recorded human prompt. */
export function buildSystem(options: GenerateOptions, workingDirectory: string | undefined, forwardHarnessContext: boolean): string {
  const sections = [options.system ?? '']
  if (workingDirectory !== undefined) sections.push(`You are working in ${workingDirectory}. Use the tools you have been given to complete the user's requested work.`)
  if (forwardHarnessContext && (options.tools?.length ?? 0) > 0) sections.push(`Available DSH capabilities: ${options.tools!.map(tool => tool.name).join(', ')}.`)
  return sections.filter(Boolean).join('\n\n')
}
