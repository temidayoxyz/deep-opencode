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
import { OpenCodeFreeAdapter } from './adapter.ts'
import { OPENCODE_FREE_ROUTE } from './catalog.ts'
import { clearCatalog, listModels, refreshCatalog } from './discovery.ts'
import { OpenCodeClient, OpenCodeRequestError } from './client.ts'
import { OpenCodeServer, type ServerConfig } from './server.ts'

export const name = 'dsh-deep-opencode'
export const inject = ['llm']

/** The provider route this plugin owns; the catalogue validates against it. */
export const ROUTE = OPENCODE_FREE_ROUTE

/** Plugin configuration; every deployment-varying value is declared here. */
export interface Config extends ServerConfig {
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
  turnTimeoutMs: 900_000,
  catalogTimeoutMs: 60_000,
  logDiagnostics: true,
}

function resolveConfig(config: Partial<Config> | undefined): Config {
  return { ...DEFAULTS, ...config }
}

export function apply(ctx: Context, config?: Partial<Config>): void {
  const resolved = resolveConfig(config)
  const server = new OpenCodeServer(resolved)
  const client = new OpenCodeClient(server)
  const adapter = new OpenCodeFreeAdapter(client, resolved.turnTimeoutMs, resolved.catalogTimeoutMs)

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
          resolvedBinary: server.binary ?? null,
          opencodeVersion: info.version ?? null,
          baseUrl: server.baseUrl ?? null,
          modelCount: models.length,
          models: models.map((model) => model.id),
        }
        ctx.logger.info(
          `deep-opencode: ${report.resolvedBinary} v${info.version ?? 'unknown'} on ${server.baseUrl ?? 'pending'}; ` +
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
          resolvedBinary: server.binary ?? null,
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

  // The managed server outlives individual turns but not the plugin: when this
  // effect unwinds the child is stopped so a reload cannot orphan a listener.
  ctx.effect(() => () => {
    void server.stop()
  })
}

export { OPENCODE_FREE_ROUTE, OPENCODE_PROVIDER, isFreeModel, toFreeModel } from './catalog.ts'
export { listModels, refreshCatalog }
export { OpenCodeClient, OpenCodeServer, OpenCodeRequestError }
export { OpenCodeFreeAdapter }
export { authorizationHeader } from './server.ts'
export type { ServerConfig } from './server.ts'
export type { FreeModel } from './catalog.ts'
export { LlmError }
