/**
 * Manages the `opencode serve` child process this adapter delegates through.
 *
 * The free-tier models on OpenCode's Zen endpoint are refused for clients that
 * are not OpenCode ("OpenCode's free tier can only be used from within
 * OpenCode"), so requests have to originate from a real OpenCode process. The
 * plugin therefore runs one long-lived `opencode serve` per Host and speaks its
 * HTTP API, which is the same shape OpenChamber uses: spawn the binary, read the
 * listening URL and password from its stdout, then talk to it.
 *
 * Nothing here pins an OpenCode version. The command is configurable, the API
 * shapes are probed at runtime, and the server's reported version is logged
 * rather than compared.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'

/** One adapter's process-management settings; all deployment-varying. */
export interface ServerConfig {
  /** Executable name or path resolved through `PATH`. */
  opencodeCommand: string
  /** Loopback host the child binds. */
  host: string
  /** Port for the child; `0` lets the OS pick a free one. */
  port: number
  /** Deadline for the child to report a listening URL, in milliseconds. */
  startupTimeoutMs: number
}

interface ServerAddress {
  baseUrl: string
  password: string
}

/**
 * Parses the two lines `opencode serve` prints on startup. Both are required:
 * without the password every API call is refused.
 *
 * Observed v2.0.18 stdout:
 *   server listening on http://127.0.0.1:51733
 *   server password 0kKcM...
 */
function parseStartup(text: string): ServerAddress | undefined {
  const url = /server listening on (https?:\/\/\S+)/.exec(text)?.[1]
  const password = /server password (\S+)/.exec(text)?.[1]
  if (url === undefined || password === undefined) return undefined
  return { baseUrl: url.replace(/\/$/, ''), password }
}

/** A running `opencode serve` child, its address, and the HTTP client bound to it. */
export class OpenCodeServer {
  readonly #config: ServerConfig
  #child: ChildProcess | undefined
  #address: ServerAddress | undefined
  #starting: Promise<ServerAddress> | undefined

  constructor(config: ServerConfig) {
    this.#config = config
  }

  /** Base URL of the running server, once started. */
  get baseUrl(): string | undefined {
    return this.#address?.baseUrl
  }

  /**
   * Starts the child if it is not already running and resolves its address.
   * Concurrent callers share one startup, and a failed startup is not cached so
   * a later attempt can retry.
   */
  async start(): Promise<ServerAddress> {
    if (this.#address !== undefined) return this.#address
    this.#starting ??= this.#launch().finally(() => {
      this.#starting = undefined
    })
    this.#address = await this.#starting
    return this.#address
  }

  async #launch(): Promise<ServerAddress> {
    const { opencodeCommand, host, port, startupTimeoutMs } = this.#config
    let child: ChildProcess
    try {
      child = spawn(opencodeCommand, ['serve', '--hostname', host, '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      // Reported as a startup failure so a missing binary surfaces the same way
      // as a server that never listens, instead of throwing from `spawn`.
      throw new Error(
        `\`${opencodeCommand} serve\` could not be started: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // `spawn` reports a missing executable asynchronously, not by throwing.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new Error(`\`${opencodeCommand}\` could not be started: ${error.message}`))
      }
      child.once('error', onError)
      child.once('spawn', () => {
        child.off('error', onError)
        resolve()
      })
    })
    this.#child = child

    let buffered = ''
    const onOutput = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8')
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    const exited = once(child, 'exit')
    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`\`${opencodeCommand} serve\` did not report a listening URL within ${startupTimeoutMs}ms`))
      }, startupTimeoutMs)
      // Do not hold the event loop open for the startup timer.
      timer.unref?.()
    })

    try {
      // `exited` resolves with the exit arguments, which is not a ServerAddress;
      // it is raced in so a child that dies before listening rejects at once.
      const address = await Promise.race<ServerAddress>([
        this.#waitForAddress(child, () => buffered),
        deadline,
        exited.then(() => {
          throw new Error(`\`${opencodeCommand} serve\` exited with code ${child.exitCode} before listening`)
        }),
      ])
      return address
    } catch (error) {
      await this.stop()
      throw error
    } finally {
      child.stdout?.off('data', onOutput)
      child.stderr?.off('data', onOutput)
    }
  }

  /** Resolves as soon as the child's stdout carries both startup lines. */
  #waitForAddress(child: ChildProcess, read: () => string): Promise<ServerAddress> {
    return new Promise<ServerAddress>((resolve, reject) => {
      const attempt = (): void => {
        const address = parseStartup(read())
        if (address !== undefined) {
          cleanup()
          resolve(address)
          return
        }
        if (child.exitCode !== null) {
          cleanup()
          reject(new Error(`\`${this.#config.opencodeCommand} serve\` exited with code ${child.exitCode} before listening`))
        }
      }
      const onData = (): void => {
        attempt()
      }
      const onExit = (): void => {
        attempt()
      }
      const cleanup = (): void => {
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        child.off('exit', onExit)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('exit', onExit)
      // stdout may already have carried the lines before this listener attached.
      attempt()
    })
  }

  /** Terminates the child and forgets the address so a later `start()` relaunches. */
  async stop(): Promise<void> {
    const child = this.#child
    this.#child = undefined
    this.#address = undefined
    if (child === undefined || child.exitCode !== null) return
    child.kill('SIGTERM')
    const exited = once(child, 'exit').catch(() => undefined)
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      timer.unref?.()
    })
    await Promise.race([exited, grace])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

/** Basic-auth header value for the server's loopback password. */
export function authorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}
