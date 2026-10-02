import { LlmError } from '@deepseek-ai/dsh-llm'

/** Bound every stage of a delegated turn, including startup and HTTP admission. */
export function turnScope(caller: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(new LlmError('OpenCode turn cancelled', 'ABORTED'))
  if (caller?.aborted) onAbort()
  else caller?.addEventListener('abort', onAbort, { once: true })
  const timer = timeoutMs > 0 ? setTimeout(() => {
    controller.abort(new LlmError(`opencode-free turn did not settle within ${timeoutMs}ms`, 'TIMEOUT'))
  }, timeoutMs) : undefined
  timer?.unref?.()
  return {
    signal: controller.signal,
    abort: onAbort,
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
    },
  }
}

/** Also settle promptly when a dependency does not implement AbortSignal. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
