/** Dependency-free OpenCode v2 companion, loaded only in our managed servers. */
interface Registration { dispose(): Promise<void> }
interface NativeContext { sessionID: string; id: string; signal: AbortSignal }
interface Catalogue { tools: { name: string; description: string; parameters: Record<string, unknown> }[]; system?: string; concluded?: boolean }
interface Reply { isError: boolean; content: { type: string; text?: string }[]; additionalContexts?: unknown[]; concludesTurn?: boolean }
interface PluginContext {
  tool: { transform(callback: (editor: {
    namespace(namespace: { name: string; description: string }): void
    add(tool: { name: string; description: string; input: Record<string, unknown>; options: { namespace: string; codemode: false }; execute(input: unknown, context: NativeContext): Promise<{ content: string }> }): void
  }) => void): Promise<Registration> }
  session: { hook(name: 'context', callback: (context: { sessionID: string; system: { type: 'text'; text: string }[]; tools: Record<string, unknown> }) => Promise<void>): Promise<Registration> }
}

export default {
  id: 'dsh-tool-bridge',
  async setup(ctx: PluginContext) {
    const baseUrl = process.env.DSH_OPENCODE_BRIDGE_URL
    const token = process.env.DSH_OPENCODE_BRIDGE_TOKEN
    if (baseUrl === undefined || token === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) throw new Error('DSH tool bridge transport is unavailable')
    const rpc = async <T>(route: string, sessionId: string, body: Record<string, unknown> = {}, signal = AbortSignal.timeout(10_000)): Promise<T | undefined> => {
      const response = await fetch(baseUrl + route, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, sessionId }), signal,
      })
      const result = await response.json() as T & { error?: string }
      if (!response.ok) {
        if (route === '/tools/list' && response.status === 403) return undefined
        throw new Error(result.error ?? 'DSH tool bridge request failed')
      }
      return result
    }
    const registrations: Registration[] = []
    try {
      registrations.push(await ctx.tool.transform(editor => {
        editor.namespace({ name: 'dsh', description: 'Tools supplied by the current DeepSeek Harness session and its plugins.' })
        editor.add({
          name: 'list', options: { namespace: 'dsh', codemode: false },
          description: 'List the DSH tool plugins available in this session, including their argument schemas. Use dsh_call to run a listed tool.',
          input: { type: 'object', properties: {}, additionalProperties: false },
          execute: async (_, context) => ({ content: JSON.stringify(await rpc<Catalogue>('/tools/list', context.sessionID, {}, context.signal) ?? { tools: [] }) }),
        })
        editor.add({
          name: 'call', options: { namespace: 'dsh', codemode: false },
          description: 'Run a DSH tool by its exact name and arguments. DSH applies its normal policies and approvals and records the result. Only tools listed for this session may run.',
          input: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false },
          execute: async (input, context) => {
            const args = input as { name: string; arguments: Record<string, unknown> }
            const result = await rpc<Reply>('/tools/call', context.sessionID, { name: args.name, arguments: args.arguments, callId: context.id }, context.signal)
            if (result === undefined) throw new Error('DSH tool returned no result')
            // Preserve error outcomes and plugin-supplied context for the model.
            return { content: JSON.stringify(result) }
          },
        })
      }))
      registrations.push(await ctx.session.hook('context', async context => {
        const catalogue = await rpc<Catalogue>('/tools/list', context.sessionID)
        if (catalogue === undefined) {
          delete context.tools.dsh_list
          delete context.tools.dsh_call
          return
        }
        if (catalogue.concluded) {
          context.tools = {}
          context.system.push({ type: 'text', text: 'The DSH tool has concluded this turn. Give a brief final response based on its result.' })
          return
        }
        context.system.push({ type: 'text', text: [
          catalogue.system ?? '',
          'DSH tool plugins are available through dsh_call. Use the exact listed name and arguments; dsh_list can refresh their schemas. Instructions naming a DSH tool mean to invoke it through dsh_call.',
          JSON.stringify(catalogue.tools),
        ].filter(Boolean).join('\n\n') })
      }))
    } catch (error) {
      await Promise.all(registrations.map(registration => registration.dispose()))
      throw error
    }
    return async () => { for (const registration of registrations.reverse()) await registration.dispose() }
  },
}
