/**
 * Deep OpenCode — the `opencode-free` provider route.
 *
 * OpenCode's Zen gateway serves a set of free models that a direct client
 * cannot use: it answers them with "OpenCode's free tier can only be used from
 * within OpenCode". This plugin registers a Host-side `ctx.llm` adapter that
 * runs a real `opencode serve` and delegates each model request to it, so the
 * request genuinely originates from OpenCode and the free models resolve.
 *
 * The route is named `opencode-free` so it never collides with the `opencode` and
 * `opencode-go` providers in the shared models.dev catalogue that the harness
 * already reads. Those are reached over plain HTTP with an API key, and their
 * free models fail; this route is the answer for the free ones.
 *
 * Model discovery reads the running server, so the offered list tracks whatever
 * that OpenCode version actually serves.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The slice of the session store this plugin reads.
     *
     * `@deepseek-ai/dsh-session` is not published to the registry, so the one
     * accessor needed here is declared instead of depended on: a session's
     * durable header carries the absolute project directory that storage keys
     * off. The read is guarded at runtime, so a shape change costs the project
     * directory rather than the route.
     */
    readonly sessions: {
      get(id: string): { readonly header: { readonly cwd?: string } } | undefined
    }
  }
}
import { OpenCodeFreeAdapter } from './adapter.ts'
import { OPENCODE_FREE_ROUTE } from './catalog.ts'
import { clearCatalog, listModels, refreshCatalog } from './discovery.ts'
import { OpenCodeClient, OpenCodeRequestError, type PermissionRule } from './client.ts'
import { OpenCodeServer, OpenCodeServerPool, type ServerConfig } from './server.ts'
import { translateEvents, type DirectoryResolver, type OpenCodeEventContext } from './adapter.ts'
import { SessionRegistry } from './session-registry.ts'
import { requestHarnessPermission, type HarnessApprovalHost } from './approval.ts'
import { HarnessToolBridge, type HarnessToolHost } from './tool-bridge.ts'
import { toolBridgeEnvironment } from './tool-bridge-environment.ts'
import { OpenCodeCompanion } from './companion-runtime.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'deep-opencode/event'(context: OpenCodeEventContext): void
    'deep-opencode/permission'(context: OpenCodeEventContext): 'once' | 'always' | 'reject' | undefined | Promise<'once' | 'always' | 'reject' | undefined>
    'deep-opencode/form'(context: OpenCodeEventContext): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  }
}

export const name = 'dsh-deep-opencode'
export const inject = ['llm', 'sessions']

/** The provider route this plugin owns; the catalogue validates against it. */
export const ROUTE = OPENCODE_FREE_ROUTE

/** Plugin configuration; every deployment-varying value is declared here. */
export interface Config extends Omit<ServerConfig, 'cwd'> {
  /**
   * Working directory for a request whose session carries no project, and the
   * directory the model catalogue is read from. Omission uses the harness's own
   * working directory. A session with a project always uses its own.
   */
  cwd?: string
  /**
   * Whether a harness session keeps one OpenCode session for its whole
   * conversation. Disabling it restores one provider session per request, which
   * gives up conversational continuity: the model cannot recall an earlier turn
   * and each turn restores the conversation through the companion.
   */
  reuseSessions: boolean
  /** Maximum harness sessions mapped to a provider session at once. */
  maxSessionMappings: number
  /** Idle lifetime of a mapping in milliseconds; `0` disables idle reclamation. */
  sessionIdleTtlMs: number
  /** Lifetime of the reclaim grace window protecting a turn in flight. */
  sessionTurnGraceMs: number
  /**
   * Milliseconds to wait for the delegated turn before ending it. OpenCode owns
   * the turn, so this bounds a turn that never settles; `0` disables the bound.
   */
  turnTimeoutMs: number
  /**
   * Where to write the discovery report. Relative paths resolve against the
   * harness home; omission writes `deep-opencode/diagnostics.json` there.
   */
  diagnosticsPath?: string
  /**
   * How long to keep asking a server that reports an empty model catalogue.
   * OpenCode answers with none until it has fetched its provider list.
   */
  catalogTimeoutMs: number
  /** Report the managed server's version and discovered models on load. */
  logDiagnostics: boolean
  /**
   * Add a capability-name summary to system context. Instructions and injected
   * messages are always supplied through the native companion.
   */
  forwardHarnessContext: boolean
  /** Native OpenCode permission rules for newly created delegated sessions. */
  sessionPermissions?: readonly PermissionRule[]
  /** Native agent name; omission uses OpenCode's configured default agent. */
  nativeAgent?: string
  /** Make this request's DSH tool plugins callable by the delegated agent. */
  bridgeHarnessTools: boolean
}

/**
 * Writes the discovery report where a user can read it.
 *
 * Desktop surfaces keep the plugin log inside the app, so an empty model picker
 * has no explanation available otherwise. The write never fails the mount: a
 * read-only harness home simply means no file.
 *
 * @returns the written path, or `undefined` when it could not be written.
 */
async function writeReport(relative: string | undefined, report: Record<string, unknown>): Promise<string | undefined> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const target = relative === undefined
    ? join(home, 'deep-opencode', 'diagnostics.json')
    : isAbsolute(relative) ? relative : join(home, relative)
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8')
    return target
  } catch {
    return undefined
  }
}

const DEFAULTS: Config = {
  opencodeCommand: 'opencode',
  host: '127.0.0.1',
  port: 0,
  startupTimeoutMs: 120_000,
  reuseSessions: true,
  maxSessionMappings: 32,
  sessionIdleTtlMs: 1_800_000,
  sessionTurnGraceMs: 600_000,
  turnTimeoutMs: 900_000,
  catalogTimeoutMs: 60_000,
  logDiagnostics: true,
  forwardHarnessContext: false,
  bridgeHarnessTools: true,
}

function resolveConfig(config: Partial<Config> | undefined): Config {
  return { ...DEFAULTS, ...config }
}

export function apply(ctx: Context, config?: Partial<Config>): void {
  const resolved = resolveConfig(config)
  let toolHost: HarnessToolHost | undefined
  const toolBridge = new HarnessToolBridge(() => toolHost)
  const pluginDirectory = fileURLToPath(new URL('./opencode/', import.meta.url))
  const companion = new OpenCodeCompanion(pluginDirectory)
  const pool = new OpenCodeServerPool(resolved, async () => toolBridgeEnvironment(toolBridge, await companion.directory()))
  // A request without a session has no project to run in, so it falls back to
  // the configured directory rather than wherever the harness was launched.
  const fallbackDirectory = resolved.cwd ?? process.cwd()
  // OpenCode fixes a session's project when its process starts, so each request
  // is served by the server owning the dsh session's own directory. Reading it
  // from the session header is what keeps a project in that project.
  const resolveDirectory: DirectoryResolver = (sessionId) => {
    if (sessionId === undefined) return undefined
    try {
      return ctx.sessions.get(sessionId)?.header.cwd
    } catch {
      // An unavailable or reshaped session store costs the project directory,
      // not the request: the pool falls back to the configured directory.
      return undefined
    }
  }
  const registry = new SessionRegistry({
    maxSessions: resolved.maxSessionMappings,
    idleTtlMs: resolved.sessionIdleTtlMs,
    turnGraceMs: resolved.sessionTurnGraceMs,
  })
  // These optional services are acquired when their plugins are available.
  // Keep the actual Host agent so DSH can apply its normal approval policies.
  let approvalHost: HarnessApprovalHost | undefined
  ctx.inject(['agents', 'approval'], (scope) => {
    const host = scope as unknown as HarnessApprovalHost
    approvalHost = host
    scope.effect(() => () => { if (approvalHost === host) approvalHost = undefined })
  })
  if (resolved.bridgeHarnessTools) ctx.inject(['agents', 'tools'], (scope) => {
    const services = scope as unknown as Pick<HarnessToolHost, 'agents' | 'tools'> & {
      on(name: 'session/event', callback: (session: { id: string }, event: { type: string; data: { turn?: number; step?: number } }) => void): unknown
    }
    const positions = new Map<string, { turn: number; step: number }>()
    services.on('session/event', (session, event) => {
      if (event.type === 'step/start' && event.data.turn !== undefined && event.data.step !== undefined) positions.set(session.id, { turn: event.data.turn, step: event.data.step })
      if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'session/end') positions.delete(session.id)
    })
    const host: HarnessToolHost = { agents: services.agents, tools: services.tools, position: agent => positions.get(agent.id) }
    toolHost = host
    scope.effect(() => () => { if (toolHost === host) toolHost = undefined; positions.clear() })
  })
  const adapter = new OpenCodeFreeAdapter(
    pool,
    fallbackDirectory,
    resolveDirectory,
    resolved.turnTimeoutMs,
    resolved.catalogTimeoutMs,
    registry,
    resolved.reuseSessions,
    resolved.forwardHarnessContext,
    {
      permissions: resolved.sessionPermissions,
      agent: resolved.nativeAgent,
      toolBridge,
      bridgeHarnessTools: resolved.bridgeHarnessTools,
      onEvent: (event) => ctx.parallel('deep-opencode/event', event),
      onPermission: async (event) => {
        const decision = await ctx.serial('deep-opencode/permission', event)
        return decision ?? requestHarnessPermission(approvalHost, event)
      },
      onForm: (event) => ctx.serial('deep-opencode/form', event),
    },
  )
  const discoveryServer = pool.forDirectory(undefined, fallbackDirectory)
  const client = new OpenCodeClient(discoveryServer)

  // `registerAdapter` is itself an effect whose disposer releases the route, so
  // the route unloads with the plugin under HMR. The handle is that disposer.
  const unregister = ctx.llm.registerAdapter([ROUTE], adapter)
  ctx.effect(() => () => {
    clearCatalog()
    unregister()
  })

  if (resolved.logDiagnostics) {
    void (async () => {
      let report: Record<string, unknown>
      try {
        const info = await client.info()
        const models = await refreshCatalog(client, resolved.catalogTimeoutMs)
        const names = models.map((model) => model.id).join(', ')
        report = {
          status: models.length > 0 ? 'ok' : 'no-models',
          opencodeCommand: resolved.opencodeCommand,
          resolvedBinary: discoveryServer.binary ?? null,
          opencodeVersion: info.version ?? null,
          baseUrl: discoveryServer.baseUrl ?? null,
          modelCount: models.length,
          models: models.map((model) => model.id),
        }
        ctx.logger.info(
          `deep-opencode: ${report.resolvedBinary} v${info.version ?? 'unknown'} on ${discoveryServer.baseUrl ?? 'pending'}; ` +
            `${models.length} free model(s): ${names.length > 0 ? names : 'none'}`,
        )
      } catch (error) {
        // A missing or broken OpenCode must not fail the mount: the route stays
        // registered and the failure surfaces on the first request, where the
        // user is asking for a model anyway.
        const message = error instanceof OpenCodeRequestError ? error.message : String(error)
        report = {
          status: 'failed',
          opencodeCommand: resolved.opencodeCommand,
          resolvedBinary: discoveryServer.binary ?? null,
          error: message,
        }
        ctx.logger.warn(`deep-opencode: model discovery failed: ${message}`)
      }
      // The desktop app keeps plugin logs where a user cannot read them, and
      // "the picker is empty" has no other explanation available, so the same
      // report is written where anyone can find it.
      const written = await writeReport(resolved.diagnosticsPath, report)
      if (written !== undefined) ctx.logger.info(`deep-opencode: diagnostics written to ${written}`)
    })()
  }

  // Warm the catalogue as soon as the route is registered, independently of the
  // diagnostics. A picker asked for its list before the first chat finds a cold
  // server, and a cold server answers empty for seconds; without this the route
  // reads as having no models at all until something else happens to warm it.
  {
    let cancelled = false
    void (async () => {
      // The first attempt shares the app's startup window with every other
      // plugin and with the desktop app's own OpenCode work, so it is retried
      // past the window rather than trusted on the first answer.
      for (const delay of [0, 5_000, 15_000]) {
        if (cancelled) return
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        if (cancelled) return
        try {
          if ((await refreshCatalog(client, resolved.catalogTimeoutMs)).length > 0) return
        } catch {
          // A server that cannot start yet is retried; the route still works,
          // and the failure surfaces on the first turn if it never recovers.
        }
      }
    })()
    ctx.effect(() => () => {
      cancelled = true
    })
  }

  // The managed servers and the mapped provider sessions outlive individual
  // turns but not the plugin: when this effect unwinds both are released so a
  // reload orphans neither a listener nor a session on disk.
  let sweep: ReturnType<typeof setInterval> | undefined
  ctx.effect(() => {
    // Turns enforce the count bound after releasing their lock. The timer
    // reclaims idle sessions, with a positive cadence when idle TTL is disabled.
    sweep = setInterval(() => {
      void registry.reclaim().then((ids) => registry.deleteSessions(ids)).catch((error) => {
        ctx.logger.warn(`deep-opencode: session reclamation failed: ${String(error)}`)
      })
    }, resolved.sessionIdleTtlMs > 0 ? resolved.sessionIdleTtlMs : 60_000)
    sweep.unref?.()
    return () => {
      if (sweep !== undefined) clearInterval(sweep)
      sweep = undefined
    }
  })

  ctx.effect(() => () => {
    return adapter.dispose().then(() => registry.deleteSessions(registry.drain()))
      .finally(async () => {
        try { await pool.stopAll() } finally {
          try { await toolBridge.dispose() } finally { await companion.dispose() }
        }
      })
      .catch((error) => ctx.logger.warn(`deep-opencode: shutdown failed: ${String(error)}`))
  })
}

export { OPENCODE_FREE_ROUTE, OPENCODE_PROVIDER, isFreeModel, toFreeModel } from './catalog.ts'
export { clearCatalog, listModels, refreshCatalog }
export { OpenCodeClient, OpenCodeServer, OpenCodeServerPool, OpenCodeRequestError }
export { SessionRegistry, deleteReclaimed, digest, planTurn } from './session-registry.ts'
export type { TurnPlan, RegistryPolicy } from './session-registry.ts'
export { OpenCodeFreeAdapter, translateEvents }
export { authorizationHeader } from './server.ts'
export type { ServerConfig } from './server.ts'
export type { PermissionRule } from './client.ts'
export type { OpenCodeIntegration, OpenCodeEventContext } from './adapter.ts'
export type { FreeModel } from './catalog.ts'
export { LlmError }
export { requestHarnessPermission }
export type { HarnessApprovalHost } from './approval.ts'
export { HarnessToolBridge, toolBridgeEnvironment }
export { OpenCodeCompanion }
export type { HarnessToolHost, HarnessToolAgent, ToolBridgeBinding, ToolBridgeTurn } from './tool-bridge.ts'
