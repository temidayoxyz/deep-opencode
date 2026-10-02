import type { HarnessToolBridge } from './tool-bridge.ts'

/** Extend the managed child's config without writing a project's config file. */
export async function toolBridgeEnvironment(bridge: HarnessToolBridge, pluginDirectory: string): Promise<Record<string, string>> {
  const address = await bridge.start()
  let config: Record<string, unknown> = {}
  if (process.env.OPENCODE_CONFIG_CONTENT !== undefined) {
    const parsed: unknown = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object')
    config = parsed as Record<string, unknown>
  }
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('OpenCode plugins must be an array')
  return {
    DSH_OPENCODE_BRIDGE_URL: address.baseUrl,
    DSH_OPENCODE_BRIDGE_TOKEN: address.token,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugins: [...(config.plugins as unknown[] | undefined ?? []), pluginDirectory] }),
  }
}
