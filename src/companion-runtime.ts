import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Keep OpenCode's file watcher outside the package pnpm replaces on update. */
export class OpenCodeCompanion {
  readonly #source: string
  readonly #parent: string
  #staging: Promise<string> | undefined
  #disposing: Promise<void> | undefined
  #disposed = false

  constructor(sourceDirectory: string, parentDirectory = tmpdir()) {
    this.#source = sourceDirectory
    this.#parent = parentDirectory
  }

  /** All managed servers use the same immutable copy for this plugin load. */
  directory(): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('OpenCode companion has been disposed'))
    this.#staging ??= this.#stage().catch((error) => {
      this.#staging = undefined
      throw error
    })
    return this.#staging
  }

  async #stage(): Promise<string> {
    const directory = await mkdtemp(join(this.#parent, 'deep-opencode-companion-'))
    try {
      // The bundled companion is dependency-free; Node also recognizes its ESM
      // format after it leaves the installed package's type:module scope.
      await copyFile(join(this.#source, 'index.js'), join(directory, 'index.js'))
      await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8')
      return directory
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  /** Called after managed processes exit, including any staging in flight. */
  dispose(): Promise<void> {
    this.#disposed = true
    this.#disposing ??= this.#remove()
    return this.#disposing
  }

  async #remove(): Promise<void> {
    const directory = await this.#staging?.catch(() => undefined)
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  }
}
