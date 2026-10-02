import { LlmAdapter, LlmError, LlmError as LlmError$1, createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, statSync } from "node:fs";
import { createServer } from "node:http";

//#region src/server.ts
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
/** Stop the exact managed process tree; native MCP children may be detached. */
async function terminate(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit").catch(() => void 0);
	if (process.platform === "win32" && child.pid !== void 0) {
		const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
		await new Promise((resolve) => {
			execFile(taskkill, [
				"/PID",
				String(child.pid),
				"/T",
				"/F"
			], {
				windowsHide: true,
				timeout: 5e3
			}, () => resolve());
		});
	}
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	let timer;
	const grace = new Promise((resolve) => {
		timer = setTimeout(resolve, 3e3);
		timer.unref?.();
	});
	await Promise.race([exited, grace]);
	if (timer !== void 0) clearTimeout(timer);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
/** Whether a path names a file this process can execute. */
function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** Whether a path names a directory a child process can be started in. */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
/**
* Finds a spawnable OpenCode for a configured command name.
*
* On Windows an `opencode` installed through npm puts a PowerShell shim on PATH,
* and a child process cannot run a `.ps1` shim: `spawn` fails with ENOENT while
* the plugin itself still mounts, which looks like a silent failure. The shim's
* directory also holds the real `opencode.exe`, so the launcher is resolved by
* trying the command as given and then the executable names beside it.
*
* Returns the names to try in order; the caller reports the first failure.
*/
function resolveCandidates(command) {
	const candidates = [command];
	if (process.platform !== "win32") return candidates;
	const separatorIndex = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
	const directory = separatorIndex === -1 ? void 0 : command.slice(0, separatorIndex + 1);
	const bare = separatorIndex === -1 ? command : command.slice(separatorIndex + 1);
	const onPath = [];
	for (const entry of (process.env.PATH ?? "").split(delimiter)) if (entry.length > 0) onPath.push(join(entry, bare));
	const npmPrefix = process.env.APPDATA;
	const npmLauncher = npmPrefix === void 0 ? void 0 : join(npmPrefix, "npm", "node_modules", "@opencode", "cli", "bin", bare.replace(/\.(ps1|cmd)$/i, ""));
	const npmShims = npmPrefix === void 0 ? [] : [join(npmPrefix, "npm", bare)];
	for (const name$1 of [
		...onPath,
		...npmShims.length > 0 ? npmShims : [],
		...npmLauncher === void 0 ? [] : [npmLauncher]
	]) if (isExecutable(name$1) && candidates.indexOf(name$1) === -1) candidates.push(name$1);
	for (const extension of [
		".exe",
		".cmd",
		""
	]) {
		const name$1 = `${bare}${extension}`;
		if (name$1 === bare) continue;
		if (directory !== void 0 && isExecutable(directory + name$1) && candidates.indexOf(directory + name$1) === -1) candidates.push(directory + name$1);
		if (npmLauncher !== void 0) {
			const candidate = `${npmLauncher}${extension}`;
			if (isExecutable(candidate) && candidates.indexOf(candidate) === -1) candidates.push(candidate);
		}
	}
	return candidates;
}
/**
* Parses the two lines `opencode serve` prints on startup. Both are required:
* without the password every API call is refused.
*
* Observed v2.0.18 stdout:
*   server listening on http://127.0.0.1:51733
*   server password 0kKcM...
*/
function parseStartup(text) {
	const url = /server listening on (https?:\/\/\S+)/.exec(text)?.[1];
	const password = /server password (\S+)/.exec(text)?.[1];
	if (url === void 0 || password === void 0) return void 0;
	return {
		baseUrl: url.replace(/\/$/, ""),
		password
	};
}
/** A running `opencode serve` child, its address, and the HTTP client bound to it. */
var OpenCodeServer = class {
	#config;
	#child;
	#address;
	#starting;
	#binary;
	#generation = 0;
	#disposed = false;
	#prepareEnvironment;
	constructor(config, prepareEnvironment) {
		this.#config = config;
		this.#prepareEnvironment = prepareEnvironment;
	}
	/** Base URL of the running server, once started. */
	get baseUrl() {
		return this.#address?.baseUrl;
	}
	/** The executable that was actually spawned, which may not be the configured name. */
	get binary() {
		return this.#binary;
	}
	/** The working directory this server runs OpenCode's agent in. */
	get cwd() {
		return this.#config.cwd;
	}
	/**
	* Starts the child if it is not already running and resolves its address.
	* Concurrent callers share one startup, and a failed startup is not cached so
	* a later attempt can retry.
	*/
	async start() {
		if (this.#disposed) throw new Error("OpenCode server has been disposed");
		if (this.#address !== void 0) return this.#address;
		this.#starting ??= this.#launch().finally(() => {
			this.#starting = void 0;
		});
		const generation$1 = this.#generation;
		const address = await this.#starting;
		if (generation$1 !== this.#generation) throw new Error("OpenCode server stopped during startup");
		this.#address = address;
		return this.#address;
	}
	async #launch() {
		const generation$1 = this.#generation;
		const environment = await this.#prepareEnvironment?.();
		if (generation$1 !== this.#generation) throw new Error("OpenCode server stopped during environment preparation");
		const { opencodeCommand, host, port, startupTimeoutMs } = this.#config;
		const candidates = resolveCandidates(opencodeCommand);
		let spawnedChild;
		let spawnedBinary;
		let lastError;
		for (const candidate of candidates) try {
			const attempt = spawn(candidate, [
				"serve",
				"--hostname",
				host,
				"--port",
				String(port)
			], {
				...environment === void 0 ? {} : { env: {
					...process.env,
					...environment
				} },
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsHide: true,
				...this.#config.cwd === void 0 ? {} : { cwd: this.#config.cwd }
			});
			if (await new Promise((resolve) => {
				const onError = (error) => {
					lastError = error.message;
					resolve(false);
				};
				attempt.once("error", onError);
				attempt.once("spawn", () => {
					attempt.off("error", onError);
					resolve(true);
				});
			})) {
				spawnedChild = attempt;
				spawnedBinary = candidate;
				break;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (spawnedChild === void 0 || spawnedBinary === void 0) throw new Error(`could not start \`opencode serve\` (configured as \`${opencodeCommand}\`, tried ${candidates.length} candidate(s): ${candidates.join(", ")})${lastError === void 0 ? "" : `: ${lastError}`}`);
		const child = spawnedChild;
		if (generation$1 !== this.#generation) {
			await terminate(child);
			throw new Error("OpenCode server stopped during spawn");
		}
		this.#binary = spawnedBinary;
		this.#child = child;
		child.once("exit", () => {
			if (this.#child === child) {
				this.#child = void 0;
				this.#address = void 0;
				this.#generation++;
			}
		});
		let buffered = "";
		const onOutput = (chunk) => {
			buffered = (buffered + chunk.toString("utf8")).slice(-16384);
		};
		child.stdout?.on("data", onOutput);
		child.stderr?.on("data", onOutput);
		const exited = once(child, "exit");
		let timer;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`\`${spawnedBinary}\` did not report a listening URL within ${startupTimeoutMs}ms`));
			}, startupTimeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([
				this.#waitForAddress(child, () => buffered),
				deadline,
				exited.then(() => {
					throw new Error(`\`${spawnedBinary}\` exited with code ${child.exitCode} before listening`);
				})
			]);
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			child.once("close", () => {
				child.stdout?.off("data", onOutput);
				child.stderr?.off("data", onOutput);
			});
		}
	}
	/** Resolves as soon as the child's stdout carries both startup lines. */
	#waitForAddress(child, read) {
		return new Promise((resolve, reject) => {
			const attempt = () => {
				const address = parseStartup(read());
				if (address !== void 0) {
					cleanup();
					resolve(address);
					return;
				}
				if (child.exitCode !== null) {
					cleanup();
					reject(/* @__PURE__ */ new Error(`\`${this.#binary ?? this.#config.opencodeCommand}\` exited with code ${child.exitCode} before listening`));
				}
			};
			const onData = () => {
				attempt();
			};
			const onExit = () => {
				attempt();
			};
			const cleanup = () => {
				child.stdout?.off("data", onData);
				child.stderr?.off("data", onData);
				child.off("exit", onExit);
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.on("exit", onExit);
			attempt();
		});
	}
	/** Terminates the child and forgets the address so a later `start()` relaunches. */
	async stop() {
		this.#generation++;
		const child = this.#child;
		this.#child = void 0;
		this.#address = void 0;
		if (child !== void 0) await terminate(child);
	}
	/** Permanently close a pooled server, including references retained by clients. */
	async dispose() {
		this.#disposed = true;
		const starting = this.#starting;
		try {
			await this.stop();
		} finally {
			await starting?.catch(() => void 0);
		}
	}
};
/** Basic-auth header value for the server's loopback password. */
function authorizationHeader(password) {
	return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}
/**
* Keeps one `opencode serve` per working directory.
*
* OpenCode decides a session's project when its process starts and ignores a
* per-request directory, so a shared server would put every project's agent in
* whichever directory happened to launch first. Servers are therefore created
* on first use for a directory and reused for it afterwards.
*/
var OpenCodeServerPool = class {
	#config;
	#servers = /* @__PURE__ */ new Map();
	#stopped = false;
	#prepareEnvironment;
	constructor(config, prepareEnvironment) {
		this.#config = config;
		this.#prepareEnvironment = prepareEnvironment;
	}
	/**
	* The server for one directory, created but not started.
	*
	* An unusable directory falls back to `fallback` rather than failing the
	* request: a turn that runs in the process directory is better than a turn
	* that never runs, and the fallback is reported in the request diagnostics.
	*
	* @param directory - absolute project directory, when the session has one
	* @param fallback - directory to use when none is supplied or it is unusable
	*/
	forDirectory(directory, fallback) {
		if (this.#stopped) throw new Error("OpenCode server pool has been stopped");
		const chosen = directory !== void 0 && isDirectory(directory) ? directory : fallback;
		const key = process.platform === "win32" ? chosen.toLowerCase() : chosen;
		const existing = this.#servers.get(key);
		if (existing !== void 0) return existing;
		const server = new OpenCodeServer({
			...this.#config,
			cwd: chosen
		}, this.#prepareEnvironment);
		this.#servers.set(key, server);
		return server;
	}
	/** The directories that currently own a server. */
	get directories() {
		return [...this.#servers.values()].map((server) => server.cwd).filter((value) => value !== void 0);
	}
	/** Stops every server, for plugin unload. */
	async stopAll() {
		this.#stopped = true;
		const servers = [...this.#servers.values()];
		this.#servers.clear();
		await Promise.all(servers.map((server) => server.dispose()));
	}
};

//#endregion
//#region src/client.ts
/**
* HTTP client for the OpenCode v2 API surface this adapter uses.
*
* The base URL, session endpoints and event stream were read from a live
* v2.0.18 server's `GET /openapi.json` and observed on the wire. No path or
* payload shape is version-gated: `capabilities()` reports what the server
* exposes so drift is visible in diagnostics instead of failing silently.
*/
/** Routes the adapter uses, named for the `operationId` each answers to. */
const ROUTES = {
	info: "/api/info",
	modelList: "/api/model",
	sessionCreate: "/api/session",
	sessionDelete: (id) => `/api/session/${id}`,
	sessionModel: (id) => `/api/session/${id}/model`,
	sessionPermissionReply: (id, request) => `/api/session/${id}/permission/${request}/reply`,
	sessionFormReply: (id, form) => `/api/session/${id}/form/${form}/reply`,
	sessionPrompt: (id) => `/api/session/${id}/prompt`,
	sessionSynthetic: (id) => `/api/session/${id}/synthetic`,
	sessionInterrupt: (id) => `/api/session/${id}/interrupt`,
	eventSubscribe: "/api/event"
};
/** A failure carrying the stable code the harness routes on. */
var OpenCodeRequestError = class extends Error {
	status;
	code;
	constructor(message, code, status) {
		super(message);
		this.name = "OpenCodeRequestError";
		this.code = code;
		this.status = status;
	}
};
/** Maps a transport or protocol failure onto one of the harness failure codes. */
function classify(status) {
	if (status === 401) return "AUTH";
	if (status === 403) return "AUTH";
	if (status === 429) return "RATE_LIMIT";
	if (status === 404) return "NO_ADAPTER";
	if (status !== void 0 && status >= 500) return "PROVIDER";
	return "TRANSPORT";
}
/** Thin wrapper over the running server's HTTP API. */
var OpenCodeClient = class {
	#server;
	constructor(server) {
		this.#server = server;
	}
	async #request(path, init = {}) {
		let baseUrl;
		let password;
		try {
			const address = await this.#server.start();
			baseUrl = address.baseUrl;
			password = address.password;
		} catch (error) {
			throw new OpenCodeRequestError(`OpenCode server unavailable: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT");
		}
		return await fetch(baseUrl + path, {
			...init,
			headers: {
				Authorization: authorizationHeader(password),
				"Content-Type": "application/json",
				...init.headers
			}
		});
	}
	/** One JSON GET/POST/DELETE, raising `OpenCodeRequestError` on a non-2xx. */
	async #json(path, init = {}) {
		const response = await this.#request(path, init);
		const text = await response.text();
		if (!response.ok) {
			let detail = text.slice(0, 400);
			try {
				const parsed$1 = JSON.parse(text);
				detail = parsed$1.message ?? parsed$1._tag ?? detail;
			} catch {}
			throw new OpenCodeRequestError(`OpenCode ${init.method ?? "GET"} ${path} failed (${response.status}): ${detail}`, classify(response.status), response.status);
		}
		if (text.length === 0) return void 0;
		const parsed = JSON.parse(text);
		return parsed.data ?? parsed;
	}
	/** `GET /api/info` — the server's own version, for diagnostics only. */
	async info() {
		return await this.#json(ROUTES.info);
	}
	/**
	* `GET /api/model` — the authoritative catalogue, including the free models.
	*
	* `#json` already unwraps the `data` envelope, so the result is the entry
	* array itself. Both a bare array and an enveloped body are accepted so a
	* server that changes its envelope does not read as an empty catalogue.
	*/
	async listModels() {
		const body = await this.#json(ROUTES.modelList);
		if (Array.isArray(body)) return body;
		return body?.data ?? [];
	}
	/** `POST /api/session` — one delegated session per dsh request. */
	async createSession(signal, permissions, agent) {
		const session = await this.#json(ROUTES.sessionCreate, {
			method: "POST",
			signal,
			body: JSON.stringify({
				...this.#server.cwd === void 0 ? {} : { location: { directory: this.#server.cwd } },
				...permissions === void 0 ? {} : { permissions },
				...agent === void 0 ? {} : { agent }
			})
		});
		if (session?.id === void 0) throw new OpenCodeRequestError("OpenCode created a session without an id", "PROTOCOL");
		return session.id;
	}
	async deleteSession(id) {
		try {
			await this.#json(ROUTES.sessionDelete(id), {
				method: "DELETE",
				signal: AbortSignal.timeout(5e3)
			});
		} catch {}
	}
	/**
	* `POST /api/session/{id}/model` — pins the session's model.
	*
	* The body is `{model: {id, providerID}}`; the server rejects a flat string
	* and a `modelID` key, so both field names are load-bearing.
	*/
	async setModel(id, model, providerID, signal) {
		await this.#json(ROUTES.sessionModel(id), {
			method: "POST",
			signal,
			body: JSON.stringify({ model: {
				id: model,
				providerID
			} })
		});
	}
	/** `POST /api/session/{id}/prompt` — enqueues one turn; output arrives on the event stream. */
	async prompt(id, text, signal, prompt) {
		await this.#json(prompt?.synthetic ? ROUTES.sessionSynthetic(id) : ROUTES.sessionPrompt(id), {
			method: "POST",
			signal,
			body: JSON.stringify({
				text,
				...prompt === void 0 ? {} : { id: prompt.id }
			})
		});
	}
	/** `POST /api/session/{id}/interrupt` — the cancellation path for an in-flight turn. */
	async interrupt(id) {
		try {
			await this.#json(ROUTES.sessionInterrupt(id), {
				method: "POST",
				signal: AbortSignal.timeout(5e3)
			});
		} catch {}
	}
	async replyPermission(id, request, decision, signal) {
		await this.#json(ROUTES.sessionPermissionReply(id, request), {
			method: "POST",
			body: JSON.stringify({ decision }),
			signal
		});
	}
	async replyForm(id, form, answer, signal) {
		await this.#json(ROUTES.sessionFormReply(id, form), {
			method: "POST",
			body: JSON.stringify({ answer }),
			signal
		});
	}
	/**
	* `GET /api/event` — the server-sent event stream every delegated turn reads.
	*
	* Yields parsed frames until `signal` aborts. A transport failure propagates
	* so the caller can end the turn with a terminal failure rather than hanging.
	*/
	async *events(signal) {
		let baseUrl;
		let password;
		try {
			const address = await this.#server.start();
			baseUrl = address.baseUrl;
			password = address.password;
		} catch (error) {
			throw new OpenCodeRequestError(`OpenCode server unavailable: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT");
		}
		const response = await fetch(baseUrl + ROUTES.eventSubscribe, {
			headers: {
				Authorization: authorizationHeader(password),
				Accept: "text/event-stream"
			},
			signal
		});
		if (!response.ok || response.body === null) throw new OpenCodeRequestError(`OpenCode event stream failed (${response.status})`, classify(response.status), response.status);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				let boundary = /\r?\n\r?\n/.exec(buffer);
				while (boundary !== null) {
					const frame = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary[0].length);
					const payload = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
					if (payload.length > 0) {
						let parsed;
						try {
							parsed = JSON.parse(payload);
						} catch {}
						if (parsed !== void 0) yield parsed;
					}
					boundary = /\r?\n\r?\n/.exec(buffer);
				}
			}
		} finally {
			await reader.cancel().catch(() => void 0);
		}
	}
};

//#endregion
//#region src/turn.ts
/** Bound every stage of a delegated turn, including startup and HTTP admission. */
function turnScope(caller, timeoutMs) {
	const controller = new AbortController();
	const onAbort = () => controller.abort(new LlmError$1("OpenCode turn cancelled", "ABORTED"));
	if (caller?.aborted) onAbort();
	else caller?.addEventListener("abort", onAbort, { once: true });
	const timer = timeoutMs > 0 ? setTimeout(() => {
		controller.abort(new LlmError$1(`opencode-free turn did not settle within ${timeoutMs}ms`, "TIMEOUT"));
	}, timeoutMs) : void 0;
	timer?.unref?.();
	return {
		signal: controller.signal,
		abort: onAbort,
		dispose() {
			if (timer !== void 0) clearTimeout(timer);
			caller?.removeEventListener("abort", onAbort);
		}
	};
}
/** Also settle promptly when a dependency does not implement AbortSignal. */
async function abortable(work, signal) {
	signal.throwIfAborted();
	let onAbort = () => void 0;
	const aborted = new Promise((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

//#endregion
//#region src/catalog.ts
/**
* The provider id OpenCode's own API lists the free models under.
*
* This is sent to `opencode serve` when a session's model is selected, and it
* is deliberately not the route name: `opencode` is also a provider in the
* shared models.dev catalogue that the harness already registers, so reusing it
* as a route would collide.
*/
const OPENCODE_PROVIDER = "opencode";
/**
* The provider route this plugin registers on `ctx.llm`.
*
* Model metadata the harness validates must carry this exact value as its
* `provider`; `OPENCODE_PROVIDER` is only ever sent over the wire.
*/
const OPENCODE_FREE_ROUTE = "opencode-free";
/** Whether one catalogue entry is a free model this route should serve. */
function isFreeModel(entry) {
	if (entry.providerID !== OPENCODE_PROVIDER) return false;
	return entry.cost !== void 0 && entry.cost.length > 0 && entry.cost.every((cost) => cost.input === 0 && cost.output === 0 && (cost.cache?.read ?? 0) === 0 && (cost.cache?.write ?? 0) === 0);
}
/** Projects one catalogue entry onto the route's model description. */
function toFreeModel(entry) {
	const context = entry.limit?.context;
	return {
		provider: OPENCODE_FREE_ROUTE,
		id: entry.id,
		name: entry.name ?? entry.id,
		inputModalities: ["text"],
		context: context === void 0 ? void 0 : { contextWindow: context },
		tools: entry.capabilities?.tools === true
	};
}

//#endregion
//#region src/discovery.ts
/** The models this route currently offers. */
let cached = [];
let generation = 0;
/**
* How long to keep asking a server that reports an empty catalogue.
*
* OpenCode fetches its provider list after it starts listening, so the first
* answers are empty while that fetch is in flight.
*/
const CATALOG_TIMEOUT_MS = 6e4;
/** Gap between those retries. */
const CATALOG_POLL_INTERVAL_MS = 1500;
/** The models the GUI model picker offers for this route. */
function listModels() {
	return cached;
}
/**
* Reads the free models from the running server and replaces the catalogue.
*
* A model OpenCode adds appears here; one it retires disappears on the next
* read. The read is deliberately uncached, because the catalogue is the thing
* that tracks OpenCode's own churn.
*
* A freshly started server answers with an empty catalogue until it finishes
* fetching the provider list, which is seconds rather than milliseconds, so an
* empty answer is retried until `timeoutMs` elapses. Reading once would report
* no models on every first load and leave the route unselectable.
*/
async function refreshCatalog(client, timeoutMs = CATALOG_TIMEOUT_MS) {
	const startedGeneration = generation;
	const deadline = Date.now() + Math.max(timeoutMs, 0);
	for (;;) {
		const entries = await client.listModels();
		if (startedGeneration !== generation) return [];
		if (entries.length > 0) {
			cached = entries.filter(isFreeModel).map(toFreeModel);
			return cached;
		}
		if (Date.now() >= deadline) {
			if (cached.length > 0) return cached;
			cached = [];
			return cached;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, CATALOG_POLL_INTERVAL_MS).unref?.();
		});
	}
}
/** The discovered catalogue as the plain model list the harness expects. */
function listModelInfo() {
	return cached;
}
/** Empties the catalogue, called when the route is released. */
function clearCatalog() {
	generation++;
	cached = [];
}

//#endregion
//#region src/prompt.ts
function readText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
/** Source, rather than text patterns, distinguishes typed text from injections. */
function isHuman(message) {
	return message.role === "user" && (message.source === void 0 || message.source.kind === "user");
}
/** Preserve producer context's original privilege level, including literal tags. */
function contextMessages(options) {
	return options.messages.filter((message) => !isHuman(message) && message.role !== "assistant" && message.source?.kind !== "tool").map((message) => ({
		role: message.role === "system" ? "system" : "user",
		text: readText(message.content)
	})).filter((message) => message.text.length > 0);
}
/** Model instructions are never concatenated into a recorded human prompt. */
function buildSystem(options, workingDirectory, forwardHarnessContext) {
	const sections = [options.system ?? ""];
	if (workingDirectory !== void 0) sections.push(`You are working in ${workingDirectory}. Use the tools you have been given to complete the user's requested work.`);
	if (forwardHarnessContext && (options.tools?.length ?? 0) > 0) sections.push(`Available DSH capabilities: ${options.tools.map((tool) => tool.name).join(", ")}.`);
	return sections.filter(Boolean).join("\n\n");
}

//#endregion
//#region src/session-registry.ts
const DEFAULTS$1 = {
	maxSessions: 32,
	idleTtlMs: 30 * 6e4,
	turnGraceMs: 10 * 6e4
};
/** The two roles OpenCode can be told about; everything else is not conversation. */
function isConversible(message) {
	return isHuman(message) || message.role === "assistant";
}
/** Projects a request's messages into identity, role and text. */
function digest(options) {
	const messages = [];
	for (const message of options.messages) {
		if (!isConversible(message)) continue;
		messages.push({
			id: message.id,
			role: message.role,
			text: readText(message.content),
			delegated: message.role === "assistant" ? message.source?.kind === "model" ? message.source.provider === "opencode-free" : true : void 0
		});
	}
	return messages;
}
/**
* Decides what a turn sends.
*
* The cursor holds the id of the last message already sent. When that id is
* still in the history, the messages after it are the delta. When it is not,
* the prefix was rewritten and the whole history is replayed instead, which is
* the safe answer: it is the current behaviour, so a divergence costs continuity
* rather than a failed turn.
*
* @param messages - the request's messages in derived order
* @param sentThrough - identity of the last message already sent, if any
* @param preambleSent - whether the preamble has already gone to this session
* @returns the messages to send and whether the session must be rebuilt
*/
function planTurn(messages, sentThrough, preambleSent) {
	if (sentThrough === void 0) return {
		messages,
		sendPreamble: !preambleSent,
		resendAll: true
	};
	const anchor = messages.findIndex((message) => message.id === sentThrough);
	if (anchor === -1) return {
		messages,
		sendPreamble: !preambleSent,
		resendAll: true
	};
	const delta = messages.slice(anchor + 1).filter((message) => message.text.length > 0 && (message.role !== "assistant" || message.delegated === false));
	if (delta.length === 0) return {
		messages: [],
		sendPreamble: false,
		resendAll: false
	};
	return {
		messages: delta,
		sendPreamble: !preambleSent,
		resendAll: false
	};
}
/** Owns the dsh-to-OpenCode session mapping and its reclamation. */
var SessionRegistry = class {
	#entries = /* @__PURE__ */ new Map();
	#policy;
	#clients = /* @__PURE__ */ new Map();
	constructor(policy = {}) {
		this.#policy = {
			...DEFAULTS$1,
			...policy
		};
	}
	/** Entries currently held, for diagnostics. */
	get size() {
		return this.#entries.size;
	}
	/** The provider session currently mapped, if any. */
	providerSession(sessionId) {
		return this.#entries.get(sessionId)?.opencodeSessionId;
	}
	/**
	* Runs one turn's mutations in order against a session's entry.
	*
	* Serialising here is what keeps two concurrent turns from reading the same
	* cursor and sending the same delta twice.
	*
	* @param sessionId - the harness session the turn belongs to
	* @param task - the work to run; receives the current entry state
	* @returns whatever `task` returns
	*/
	async withEntry(sessionId, task) {
		const existing = this.#entries.get(sessionId) ?? this.#insertPlaceholder(sessionId);
		existing.pending++;
		const run = existing.queue.then(() => this.#runEntry(sessionId, task), () => this.#runEntry(sessionId, task));
		existing.queue = run.then(() => void 0, () => void 0);
		try {
			return await run;
		} finally {
			existing.pending--;
			existing.lastUsed = Date.now();
		}
	}
	/** Runs `task` with the live entry, creating one on first use. */
	async #runEntry(sessionId, task) {
		const entry = this.#entries.get(sessionId) ?? this.#insertPlaceholder(sessionId);
		entry.lastUsed = Date.now();
		const result = await task({
			entry,
			opencodeSessionId: entry.opencodeSessionId
		});
		entry.lastUsed = Date.now();
		return result;
	}
	/** Stores a minimal entry so a queue exists before the first real turn. */
	#insertPlaceholder(sessionId) {
		const entry = this.#placeholder();
		this.#entries.set(sessionId, entry);
		return entry;
	}
	/** Builds a minimal entry: no provider session yet, nothing sent. */
	#placeholder() {
		return {
			opencodeSessionId: "",
			sentThrough: void 0,
			sentCount: 0,
			preambleSent: false,
			lastUsed: Date.now(),
			queue: Promise.resolve(),
			pending: 0
		};
	}
	/**
	* Records a freshly created provider session for a harness session.
	*
	* The count bound is enforced here rather than only on a periodic sweep, so
	* the registry cannot exceed `maxSessions` between sweeps.
	*
	* @returns provider sessions evicted to make room, for the caller to delete
	*/
	async adopt(sessionId, opencodeSessionId) {
		await this.withEntry(sessionId, async ({ entry }) => {
			entry.opencodeSessionId = opencodeSessionId;
			entry.sentThrough = void 0;
			entry.sentCount = 0;
			entry.preambleSent = false;
			entry.history = void 0;
			entry.replay = void 0;
		});
		return this.#enforceCountBound();
	}
	/** Drops least-recently-used entries past the count bound. */
	#enforceCountBound() {
		const evicted = [];
		if (this.#entries.size <= this.#policy.maxSessions) return evicted;
		const byAge = [...this.#entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		for (const [sessionId, entry] of byAge) {
			if (this.#entries.size <= this.#policy.maxSessions) break;
			if (entry.pending > 0) continue;
			if (entry.opencodeSessionId !== "") evicted.push(entry.opencodeSessionId);
			this.#entries.delete(sessionId);
		}
		return evicted;
	}
	/** Records how much of the conversation the provider session now holds. */
	async advance(sessionId, plan) {
		await this.withEntry(sessionId, async ({ entry }) => {
			const last = plan.messages.at(-1);
			if (last?.id !== void 0) entry.sentThrough = last.id;
			entry.sentCount += plan.messages.length;
			if (plan.sendPreamble) entry.preambleSent = true;
		});
	}
	/** Marks a provider session unusable, so the next turn creates a fresh one. */
	async invalidate(sessionId) {
		const entry = this.#entries.get(sessionId);
		if (entry === void 0) return;
		entry.opencodeSessionId = "";
		entry.sentThrough = void 0;
		entry.sentCount = 0;
		entry.preambleSent = false;
		entry.history = void 0;
		entry.replay = void 0;
	}
	/** Drops one harness session and returns its provider session for deletion. */
	async release(sessionId) {
		const entry = this.#entries.get(sessionId);
		if (entry === void 0) return void 0;
		this.#entries.delete(sessionId);
		return entry.opencodeSessionId === "" ? void 0 : entry.opencodeSessionId;
	}
	/**
	* Reclaims entries past the count bound or idle past the TTL.
	*
	* Active and queued turns are protected until their queue drains. Idle
	* entries also respect `turnGraceMs` from their last touch.
	*
	* @returns the provider sessions to delete, for the caller to remove
	*/
	async reclaim(now = Date.now()) {
		const expired = [];
		for (const [sessionId, entry] of this.#entries) {
			if (entry.pending > 0 || this.#policy.idleTtlMs <= 0) continue;
			if (now - entry.lastUsed < this.#policy.turnGraceMs) continue;
			if (this.#policy.idleTtlMs > 0 && now - entry.lastUsed < this.#policy.idleTtlMs) continue;
			if (entry.opencodeSessionId !== "") expired.push(entry.opencodeSessionId);
			this.#entries.delete(sessionId);
		}
		expired.push(...this.#enforceCountBound());
		return expired;
	}
	/** Every provider session currently held, for shutdown. */
	all() {
		return [...this.#entries.values()].map((entry) => entry.opencodeSessionId).filter((id) => id !== "");
	}
	/**
	* Forgets every mapping and returns the provider sessions to delete.
	*
	* Used on plugin unload, where the provider servers are about to be stopped
	* anyway, so the sessions would be left behind on disk.
	*/
	drain() {
		const ids = this.all();
		this.#entries.clear();
		return ids;
	}
	/** Reclaimed sessions must be deleted through the server that created them. */
	bindClient(id, client) {
		this.#clients.set(id, client);
	}
	async deleteSessions(ids) {
		for (const id of ids) {
			const client = this.#clients.get(id);
			this.#clients.delete(id);
			await client?.deleteSession(id);
		}
	}
};
/** Deletes provider sessions the registry no longer owns. */
async function deleteReclaimed(client, ids) {
	for (const id of ids) await client.deleteSession(id);
}

//#endregion
//#region src/wire.ts
/**
* Event names the translator recognises. Aliases cover the older
* `session.reasoning.*` spelling so a turn keeps working if OpenCode renames
* one family; an unrecognised event is ignored rather than fatal.
*/
const TEXT_STARTED = "session.text.started";
const TEXT_DELTA = "session.text.delta";
const TEXT_ENDED = "session.text.ended";
const REASONING_STARTED = ["session.reasoning.started", "session.thinking.started"];
const REASONING_DELTA = ["session.reasoning.delta", "session.thinking.delta"];
const REASONING_ENDED = ["session.reasoning.ended", "session.thinking.ended"];
const STEP_ENDED = "session.step.ended";
const EXECUTION_SUCCEEDED = "session.execution.succeeded";
const EXECUTION_FAILED = [
	"session.execution.failed",
	"session.error",
	"session.execution.aborted",
	"session.execution.interrupted"
];

//#endregion
//#region src/adapter.ts
/**
* The `opencode-free` adapter: one delegated turn per model request.
*
* OpenCode's Zen endpoint refuses its free models for clients that are not
* OpenCode, so this adapter does not call the gateway at all. It runs a real
* `opencode serve` and asks that process to run the turn, translating the
* server's event stream into the harness stream protocol. This is the same
* arrangement OpenChamber uses, and the reason no API key is involved.
*
* Protocol obligations honoured here: `usage` precedes `finish`, nothing is
* emitted after `finish`, and block indexes remain distinct across all model
* steps. Transport errors are normalised by the Harness LLM service.
*/
/**
* A single-consumer async queue fed by a background reader.
*
* The provider's event stream is consumed by its own task while the request's
* generator drains this queue, which keeps the stream protocol's yields in one
* place and lets the subscription be established before the prompt is sent.
*/
var AsyncQueue = class {
	#items = [];
	#waiters = [];
	#failure;
	#closed = false;
	push(item) {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter !== void 0) {
			waiter({
				value: item,
				done: false
			});
			return;
		}
		this.#items.push(item);
	}
	/** Records the failure and closes; a failure is reported after queued chunks. */
	fail(error) {
		this.#failure = error;
		this.close();
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({
			value: void 0,
			done: true
		});
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			const item = this.#items.shift();
			if (item !== void 0) {
				yield item;
				continue;
			}
			if (this.#closed) {
				if (this.#failure !== void 0) throw this.#failure;
				return;
			}
			await new Promise((resolve) => {
				this.#waiters.push((result) => {
					if (result.done === false) this.#items.unshift(result.value);
					resolve();
				});
			});
		}
	}
};
function freshBlocks() {
	return {
		next: 0,
		indexes: /* @__PURE__ */ new Map(),
		assistantMessageID: void 0,
		usage: void 0,
		finish: { kind: "stop" }
	};
}
/** Allocates the harness index for one provider block, reusing it after the first sight. */
function indexFor(blocks, kind, ordinal) {
	const key = `${kind}:${ordinal}`;
	const existing = blocks.indexes.get(key);
	if (existing !== void 0) return existing;
	const allocated = blocks.next++;
	blocks.indexes.set(key, allocated);
	return allocated;
}
/** A model request delegated to a running OpenCode server. */
var OpenCodeFreeAdapter = class extends LlmAdapter {
	#pool;
	#fallbackDirectory;
	#resolveDirectory;
	#registry;
	#reuseSessions;
	#turnTimeoutMs;
	#catalogTimeoutMs;
	/** The in-flight background catalogue read, so concurrent picks share one. */
	#refreshInFlight;
	/** Whether the harness system prompt and tool list are forwarded verbatim. */
	#forwardHarnessContext;
	#integration;
	#turns = /* @__PURE__ */ new Map();
	#disposed = false;
	constructor(pool, fallbackDirectory, resolveDirectory, turnTimeoutMs, catalogTimeoutMs, registry, reuseSessions = true, forwardHarnessContext = false, integration = {}) {
		super();
		this.#pool = pool;
		this.#fallbackDirectory = fallbackDirectory;
		this.#resolveDirectory = resolveDirectory;
		this.#registry = registry;
		this.#reuseSessions = reuseSessions;
		this.#turnTimeoutMs = turnTimeoutMs;
		this.#catalogTimeoutMs = catalogTimeoutMs;
		this.#forwardHarnessContext = forwardHarnessContext;
		this.#integration = integration;
	}
	/** The server owning one request's project directory. */
	#serverFor(sessionId) {
		return this.#pool.forDirectory(this.#resolveDirectory(sessionId), this.#fallbackDirectory);
	}
	/** A client bound to the server owning this request's project directory. */
	#clientFor(sessionId) {
		return new OpenCodeClient(this.#serverFor(sessionId));
	}
	/** Route display metadata for the selector. */
	providerInfo(provider) {
		return {
			id: provider,
			name: "OpenCode Free"
		};
	}
	/**
	* The free models the running server offers.
	*
	* Read from the server rather than a pinned list, so a free model OpenCode
	* adds appears without a plugin update. An unreachable server advertises
	* nothing, which leaves the route unselectable in the GUI instead of
	* offering a model that would fail. The catalogue is provider-wide, so it is
	* read from the fallback directory's server rather than starting one per
	* project.
	*/
	async listModels() {
		const known = listModelInfo();
		if (known.length > 0) {
			this.#refreshInBackground();
			return known;
		}
		try {
			const models = await refreshCatalog(this.#clientFor(void 0), this.#catalogTimeoutMs);
			if (models.length > 0) return models;
			return await this.#catalogFromAnyRunningServer();
		} catch {
			return listModelInfo();
		}
	}
	/**
	* Refreshes the catalogue without making the caller wait for it.
	*
	* A read that fails leaves the previous catalogue in place, so a picker that
	* refreshes in the background never sees the list empty out from under it.
	*/
	#refreshInBackground() {
		this.#refreshInFlight ??= refreshCatalog(this.#clientFor(void 0), this.#catalogTimeoutMs).catch(() => listModelInfo()).finally(() => {
			this.#refreshInFlight = void 0;
		});
	}
	/** The catalogue, read from whichever server in the pool can report one. */
	async #catalogFromAnyRunningServer() {
		const fallback = this.#pool.forDirectory(void 0, this.#fallbackDirectory).cwd;
		for (const directory of this.#pool.directories) {
			if (fallback !== void 0 && directory.toLowerCase() === fallback.toLowerCase()) continue;
			try {
				const models = await refreshCatalog(new OpenCodeClient(this.#pool.forDirectory(directory, this.#fallbackDirectory)), Math.min(this.#catalogTimeoutMs, 15e3));
				if (models.length > 0) return models;
			} catch {}
		}
		return listModelInfo();
	}
	/**
	* Metadata for one exact model, from the same discovery read.
	*
	* Resolution is advisory and independent of the catalogue, so an id the
	* catalogue does not list still resolves and a request can still route; the
	* GUI is the surface that requires membership.
	*/
	async resolveModel(provider, model) {
		const found = (await this.listModels()).find((entry) => entry.id === model);
		const resolved = {
			provider,
			id: model,
			name: found?.name ?? model
		};
		const context = found?.context;
		if (context !== void 0) resolved.context = context;
		if (found?.inputModalities !== void 0) resolved.inputModalities = found.inputModalities;
		return resolved;
	}
	/**
	* Runs one delegated turn.
	*
	* A harness session is mapped onto one OpenCode session so the provider keeps
	* the conversation, and only what is new is sent. When no mapping exists, or
	* the cursor found the history had been rewritten, the whole conversation is
	* replayed into a fresh provider session instead, so a divergence costs
	* continuity rather than a failed turn. Turns are serialised per harness
	* session so two cannot read the same cursor.
	*
	* The request runs against the server owning the session's project directory,
	* and session creation specifies its native location explicitly.
	*/
	async *stream(options) {
		if (this.#disposed) throw new LlmError$1("OpenCode adapter has been unloaded", "ABORTED");
		const scope = turnScope(options.signal, this.#turnTimeoutMs);
		const queue = new AsyncQueue();
		const registry = this.#registry;
		const mapped = options.sessionId !== void 0 && options.purpose === void 0 && this.#reuseSessions && registry !== void 0;
		const onAbort = () => queue.fail(toLlmError(scope.signal.reason));
		scope.signal.addEventListener("abort", onAbort, { once: true });
		if (scope.signal.aborted) onAbort();
		const run = async (state) => {
			scope.signal.throwIfAborted();
			const conversation = digest(options);
			const server = this.#serverFor(options.sessionId);
			const client = new OpenCodeClient(server);
			const entry = state?.entry;
			let sessionId = entry?.opencodeSessionId ?? "";
			let succeeded = false;
			let terminal;
			let reader;
			let toolBinding;
			const subscription = new AbortController();
			const signal = AbortSignal.any([scope.signal, subscription.signal]);
			let plan = entry?.preambleSent && entry.history?.length === 0 ? {
				messages: conversation.filter((message) => message.role !== "assistant" || message.delegated === false),
				sendPreamble: false,
				resendAll: false
			} : planTurn(conversation, entry?.sentThrough, entry?.preambleSent ?? false);
			if (entry !== void 0 && (entry.directory !== server.cwd || entry.history?.some((previous, index) => {
				const current = conversation[index];
				return current?.id !== previous.id || current?.role !== previous.role || current?.text !== previous.text;
			}))) plan = {
				messages: conversation,
				sendPreamble: true,
				resendAll: true
			};
			try {
				if (sessionId === "" || plan.resendAll) {
					const previous = sessionId;
					const creating = client.createSession(signal, this.#integration.permissions, this.#integration.agent);
					creating.then((id) => {
						if (scope.signal.aborted) client.deleteSession(id);
					}, () => void 0);
					sessionId = await abortable(creating, signal);
					if (entry !== void 0) {
						entry.opencodeSessionId = sessionId;
						entry.directory = server.cwd;
						entry.sentThrough = void 0;
						entry.history = void 0;
						entry.replay = void 0;
						entry.sentCount = 0;
						entry.preambleSent = false;
						registry?.bindClient(sessionId, client);
					}
					if (previous !== "") await registry?.deleteSessions([previous]);
				}
				const injected = contextMessages(options);
				const humanIndex = options.purpose === void 0 ? plan.messages.findLastIndex((message) => message.role === "user" && message.text.length > 0) : -1;
				const human = plan.messages[humanIndex];
				if (human === void 0 && injected.length === 0 && !(options.purpose !== void 0 && (options.system || plan.messages.some((message) => message.text.length > 0)))) throw new LlmError$1("opencode-free received a request with no new text to send", "INVALID_REQUEST");
				const promptId = `msg_${randomBytes(32).toString("hex")}`;
				const replayMessages = plan.messages.filter((message, index) => index !== humanIndex && message.text.length > 0).map(({ role, text: text$1 }) => ({
					role,
					text: text$1
				}));
				const replay = [...(entry?.replay ?? []).filter((group) => !group.compacted), ...replayMessages.length > 0 ? [{
					before: promptId,
					messages: replayMessages
				}] : []];
				if (this.#integration.toolBridge !== void 0) toolBinding = this.#integration.toolBridge.bind({
					harnessSessionId: options.sessionId,
					providerSessionId: sessionId,
					tools: options.sessionId !== void 0 && options.purpose === void 0 && this.#integration.bridgeHarnessTools !== false ? options.tools ?? [] : [],
					model: options.model,
					system: buildSystem(options, options.purpose === void 0 ? server.cwd : void 0, this.#forwardHarnessContext),
					signal,
					context: {
						before: promptId,
						replay,
						messages: injected
					}
				});
				else if (injected.length > 0 || replay.length > 0 || options.system) throw new LlmError$1("DSH context and history replay require the OpenCode companion transport", "NO_TOOL_BRIDGE");
				await abortable(client.setModel(sessionId, options.model, OPENCODE_PROVIDER, signal), signal);
				const text = human?.text ?? "Continue using the current DSH context.";
				const blocks = freshBlocks();
				let finished = false;
				reader = client.events(signal)[Symbol.asyncIterator]();
				if ((await abortable(reader.next(), signal)).done) throw new LlmError$1("OpenCode event stream closed before prompting", "PROTOCOL");
				const pump = (async () => {
					for (;;) {
						const step = await abortable(reader.next(), signal);
						if (step.done) {
							if (!finished) throw new LlmError$1("OpenCode ended the turn without a terminal event", "PROTOCOL");
							return;
						}
						const event = step.value;
						if ((event.data?.sessionID ?? (event.data?.form)?.sessionID ?? (event.data?.request)?.sessionID) !== sessionId) continue;
						await abortable(Promise.resolve(this.#integration.onEvent?.({
							harnessSessionId: options.sessionId,
							providerSessionId: sessionId,
							event,
							signal
						})), signal);
						await this.#handleInteraction(client, sessionId, event, options.sessionId, signal);
						for (const chunk of translate(event, blocks)) if (chunk.type === "finish") {
							finished = true;
							terminal = chunk;
						} else queue.push(chunk);
						if (finished) return;
					}
				})();
				pump.catch(() => void 0);
				await abortable(Promise.all([client.prompt(sessionId, text, signal, {
					id: promptId,
					synthetic: human === void 0
				}), pump]), signal);
				succeeded = terminal?.reason.kind === "stop" || terminal?.reason.kind === "max-tokens";
				if (succeeded && entry !== void 0) {
					entry.sentThrough = conversation.at(-1)?.id;
					entry.sentCount = conversation.length;
					entry.preambleSent = true;
					entry.history = conversation;
					entry.replay = replay;
				}
			} finally {
				subscription.abort();
				reader?.return?.(void 0).catch(() => void 0);
				if (!succeeded && sessionId !== "") {
					await client.interrupt(sessionId);
					if (entry !== void 0) {
						entry.opencodeSessionId = "";
						entry.sentThrough = void 0;
						entry.history = void 0;
						entry.replay = void 0;
						entry.preambleSent = false;
					}
				}
				if ((!mapped || !succeeded) && sessionId !== "") if (mapped) await registry.deleteSessions([sessionId]);
				else await client.deleteSession(sessionId);
				await toolBinding?.close();
			}
			if (terminal !== void 0) queue.push(terminal);
		};
		const task = (mapped ? registry.withEntry(options.sessionId, run) : run()).catch((error) => queue.fail(toLlmError(error))).then(async () => {
			if (registry !== void 0) await registry.deleteSessions(await registry.reclaim());
		}).catch((error) => queue.fail(toLlmError(error))).finally(() => {
			queue.close();
			this.#turns.delete(scope);
		});
		this.#turns.set(scope, task);
		try {
			for await (const chunk of queue) yield chunk;
		} finally {
			scope.abort();
			scope.dispose();
			scope.signal.removeEventListener("abort", onAbort);
			if (this.#integration.toolBridge !== void 0) await task;
		}
	}
	/** End every delegated execution before stopping its managed servers. */
	async dispose() {
		this.#disposed = true;
		for (const scope of this.#turns.keys()) scope.abort();
		await Promise.allSettled(this.#turns.values());
	}
	async #handleInteraction(client, sessionId, event, harnessSessionId, signal) {
		const context = {
			harnessSessionId,
			providerSessionId: sessionId,
			event,
			signal
		};
		if (event.type === "permission.asked" || event.type === "session.permission.asked" || event.type === "permission.requested") {
			const id = (event.data?.request ?? event.data)?.id;
			const decision = await abortable(Promise.resolve(this.#integration.onPermission?.(context)), signal);
			if (id === void 0 || ![
				"once",
				"always",
				"reject"
			].includes(decision ?? "")) throw new LlmError$1("OpenCode needs permission to continue. Connect a deep-opencode/permission handler or configure session permissions.", "INTERACTION_REQUIRED");
			await abortable(client.replyPermission(sessionId, id, decision, signal), signal);
		}
		if (event.type === "session.form.created" || event.type === "form.created") {
			const id = (event.data?.form ?? event.data)?.id;
			const answer = await abortable(Promise.resolve(this.#integration.onForm?.(context)), signal);
			if (id === void 0 || answer === void 0) throw new LlmError$1("OpenCode needs an answer to continue. Connect a deep-opencode/form handler.", "INTERACTION_REQUIRED");
			await abortable(client.replyForm(sessionId, id, answer, signal), signal);
		}
	}
};
/**
* Maps one server event onto zero or more stream chunks.
*
* Unknown event types yield nothing rather than failing the turn, so a renamed
* auxiliary event costs observability but not the request. A turn that produces
* no text at all still fails, at the caller, because a silent empty turn is the
* one drift that must not pass unnoticed.
*/
function* translate(event, blocks) {
	const type = event.type;
	if (type === void 0) return;
	const data = event.data ?? {};
	if (data.assistantMessageID !== void 0) {
		if (blocks.assistantMessageID !== data.assistantMessageID) {
			blocks.indexes.clear();
			blocks.assistantMessageID = data.assistantMessageID;
		}
	}
	if (type === TEXT_STARTED) {
		yield {
			type: "block-start",
			index: indexFor(blocks, "text", data.ordinal ?? 0),
			blockType: "text"
		};
		return;
	}
	if (type === TEXT_DELTA) {
		if (data.delta === void 0) return;
		yield {
			type: "text-delta",
			index: indexFor(blocks, "text", data.ordinal ?? 0),
			text: data.delta
		};
		return;
	}
	if (type === TEXT_ENDED) {
		yield {
			type: "block-end",
			index: indexFor(blocks, "text", data.ordinal ?? 0),
			block: {
				type: "text",
				text: data.text ?? ""
			}
		};
		blocks.indexes.delete(`text:${data.ordinal ?? 0}`);
		return;
	}
	if (REASONING_STARTED.includes(type)) {
		yield {
			type: "block-start",
			index: indexFor(blocks, "reasoning", data.ordinal ?? 0),
			blockType: "reasoning"
		};
		return;
	}
	if (REASONING_DELTA.includes(type)) {
		if (data.delta === void 0) return;
		yield {
			type: "reasoning-delta",
			index: indexFor(blocks, "reasoning", data.ordinal ?? 0),
			text: data.delta
		};
		return;
	}
	if (REASONING_ENDED.includes(type)) {
		yield {
			type: "block-end",
			index: indexFor(blocks, "reasoning", data.ordinal ?? 0),
			block: {
				type: "reasoning",
				text: data.text ?? ""
			}
		};
		blocks.indexes.delete(`reasoning:${data.ordinal ?? 0}`);
		return;
	}
	if (type === STEP_ENDED) {
		if (data.tokens !== void 0) {
			const step = toUsage(data.tokens);
			blocks.usage ??= {
				inputTokens: 0,
				outputTokens: 0
			};
			for (const key of Object.keys(step)) blocks.usage[key] = (blocks.usage[key] ?? 0) + (step[key] ?? 0);
		}
		const reason = toFinishReason(data.finish, data.rawFinish);
		if (reason.kind !== "tool-calls") blocks.finish = reason;
		return;
	}
	if (EXECUTION_FAILED.includes(type) || type === "session.execution.interrupted") {
		const message = typeof data.message === "string" ? data.message : JSON.stringify(data.error ?? "OpenCode reported a failed execution");
		if (blocks.usage !== void 0) yield {
			type: "usage",
			usage: blocks.usage
		};
		yield {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message,
					code: type === "session.execution.interrupted" ? "ABORTED" : "PROVIDER"
				}
			}
		};
		return;
	}
	if (type === EXECUTION_SUCCEEDED) {
		if (blocks.usage === void 0) throw new LlmError$1("OpenCode ended the turn without token usage", "PROTOCOL");
		yield {
			type: "usage",
			usage: blocks.usage
		};
		yield {
			type: "finish",
			reason: blocks.finish
		};
		return;
	}
}
/**
* Converts OpenCode's token counters to the harness vocabulary.
*
* `input` is already disjoint from cache reads, so it maps straight onto
* `inputTokens`; cache reads and writes are reported separately, which is what
* makes a cache hit visible as a saving rather than as free input.
*/
function toUsage(tokens) {
	const input = tokens.input ?? 0;
	const output = tokens.output ?? 0;
	const cacheRead = tokens.cache?.read;
	const cacheWrite = tokens.cache?.write;
	const reasoning = tokens.reasoning;
	const usage = {
		inputTokens: input,
		outputTokens: output
	};
	if (cacheRead !== void 0) usage.cacheReadTokens = cacheRead;
	if (cacheWrite !== void 0) usage.cacheWriteTokens = cacheWrite;
	if (reasoning !== void 0 && reasoning > 0) usage.reasoningTokens = reasoning;
	usage.totalTokens = input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
	return usage;
}
/** Maps a provider finish string onto the harness finish reasons. */
function toFinishReason(finish, rawFinish) {
	const value = (rawFinish ?? finish ?? "").toLowerCase();
	if (value === "length" || value === "max_tokens" || value === "max-tokens") return { kind: "max-tokens" };
	if (value === "tool_calls" || value === "tool-calls") return { kind: "tool-calls" };
	return { kind: "stop" };
}
/**
* Translates a fixed event sequence into stream chunks.
*
* Exposed so the block-indexing rules can be exercised against a known event
* order, including a reasoning block followed by a text block that both number
* themselves from zero. That collision is the one a live model reproduces only
* intermittently, and when it happened it silently dropped a turn's whole
* answer while leaving the thinking visible.
*
* @param events - provider events in the order the server published them
* @returns the equivalent harness stream chunks
*/
function translateEvents(events) {
	const blocks = freshBlocks();
	const chunks = [];
	for (const event of events) for (const chunk of translate(event, blocks)) chunks.push(chunk);
	return chunks;
}
/** Normalises a client failure onto the harness error taxonomy. */
function toLlmError(error) {
	if (error instanceof LlmError$1) return error;
	if (error instanceof OpenCodeRequestError) return new LlmError$1(error.message, error.code, { cause: error });
	return new LlmError$1(error instanceof Error ? error.message : String(error), "TRANSPORT");
}

//#endregion
//#region src/approval.ts
/** Route a native permission through DSH's policies, answerers, and audit trail. */
async function requestHarnessPermission(host, context) {
	context.signal.throwIfAborted();
	if (context.harnessSessionId === void 0 || host?.agents?.get === void 0 || host.approval?.request === void 0) return void 0;
	const agent = host.agents.get(context.harnessSessionId);
	if (agent === void 0) return void 0;
	const details = context.event.data?.request ?? context.event.data;
	const action = typeof details?.action === "string" ? details.action : "action";
	const resources = Array.isArray(details?.resources) ? details.resources.filter((item) => typeof item === "string") : [];
	const message = typeof details?.message === "string" ? details.message : "";
	const decision = await abortable(host.approval.request({
		agent,
		toolName: `opencode:${action}`,
		reason: [`OpenCode requests ${action}${resources.length > 0 ? ` on ${resources.join(", ")}` : ""}.`, message].filter(Boolean).join(" "),
		signal: context.signal
	}), context.signal);
	context.signal.throwIfAborted();
	if (decision === "allowed-once") return "once";
	if (decision === "rejected" || decision === "cancelled") return "reject";
}

//#endregion
//#region src/tool-bridge.ts
var BridgeError = class extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
};
const MAX_BODY_BYTES = 1048576;
/** Authenticated loopback transport, scoped to a single active delegated turn. */
var HarnessToolBridge = class {
	#host;
	#token = randomBytes(32).toString("hex");
	#bindings = /* @__PURE__ */ new Map();
	#server;
	#starting;
	#disposed = false;
	constructor(host) {
		this.#host = host;
	}
	start() {
		if (this.#disposed) return Promise.reject(new LlmError$1("DSH tool bridge has been unloaded", "ABORTED"));
		return this.#starting ??= new Promise((resolve, reject) => {
			const server = createServer((request, response) => {
				this.#handle(request, response);
			});
			this.#server = server;
			server.requestTimeout = 3e4;
			server.headersTimeout = 1e4;
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				if (this.#disposed) return reject(new LlmError$1("DSH tool bridge has been unloaded", "ABORTED"));
				const address = server.address();
				if (typeof address !== "object" || address === null) return reject(/* @__PURE__ */ new Error("DSH tool bridge has no listening address"));
				resolve({
					baseUrl: `http://127.0.0.1:${address.port}`,
					token: this.#token
				});
			});
			server.unref();
		});
	}
	bind(turn) {
		turn.signal.throwIfAborted();
		if (this.#disposed) throw new LlmError$1("DSH tool bridge has been unloaded", "ABORTED");
		const host = this.#host();
		const agent = turn.harnessSessionId === void 0 ? void 0 : host?.agents.get(turn.harnessSessionId);
		const position = agent === void 0 ? void 0 : host?.position(agent);
		if (turn.tools.length > 0 && (host === void 0 || typeof host.tools?.execute !== "function" || agent === void 0 || position === void 0)) throw new LlmError$1("DSH tools need a live agent, tool runtime, and open step to run through OpenCode", "NO_TOOL_BRIDGE");
		if (this.#bindings.has(turn.providerSessionId)) throw new LlmError$1("DSH tool bridge session is already bound", "PROTOCOL");
		const abort = new AbortController();
		const binding = {
			turn,
			abort,
			owner: turn.tools.length > 0 && host !== void 0 && agent !== void 0 && position !== void 0 ? {
				host,
				agent,
				position
			} : void 0,
			signal: AbortSignal.any([turn.signal, abort.signal]),
			schemas: new Map(turn.tools.map((schema) => [schema.name, JSON.parse(JSON.stringify(schema))])),
			calls: /* @__PURE__ */ new Map(),
			queue: Promise.resolve(),
			closed: false,
			concluded: false,
			close: async () => {
				binding.closed = true;
				abort.abort();
				await binding.queue.catch(() => void 0);
				if (this.#bindings.get(turn.providerSessionId) === binding) this.#bindings.delete(turn.providerSessionId);
			}
		};
		this.#bindings.set(turn.providerSessionId, binding);
		return binding;
	}
	async dispose() {
		this.#disposed = true;
		await Promise.all([...this.#bindings.values()].map((binding) => binding.close()));
		await this.#starting?.catch(() => void 0);
		if (this.#server !== void 0) {
			const server = this.#server;
			await new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			this.#server = void 0;
		}
	}
	async #handle(request, response) {
		try {
			const provided = Buffer.from(request.headers.authorization ?? "");
			const expected = Buffer.from(`Bearer ${this.#token}`);
			if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new BridgeError("Unauthorized", 401);
			if (request.headers.origin !== void 0) throw new BridgeError("Browser origins are not accepted", 403);
			if (request.method !== "POST") throw new BridgeError("Use POST", 405);
			if (request.url !== "/context" && request.url !== "/tools/list" && request.url !== "/tools/call") throw new BridgeError("Unknown bridge route", 404);
			if (!request.headers["content-type"]?.startsWith("application/json")) throw new BridgeError("Use application/json", 415);
			const body = await readBody(request);
			const binding = typeof body.sessionId === "string" ? this.#bindings.get(body.sessionId) : void 0;
			if (binding === void 0 || binding.closed || binding.signal.aborted) throw new BridgeError("No active DSH tool session", 403);
			if (binding.owner !== void 0 && !this.#ownsOpenStep(binding)) throw new BridgeError("DSH tool owner is no longer available", 403);
			if (request.url === "/tools/list" || request.url === "/context") {
				const context = binding.turn.context;
				if (request.url === "/context" && body.phase === "context" && context !== void 0) {
					if (!Array.isArray(body.messageIds) || body.messageIds.some((id) => typeof id !== "string")) throw new BridgeError("Invalid native message identities", 400);
					const ids = new Set(body.messageIds);
					for (const group of context.replay) if (!ids.has(group.before)) group.compacted = true;
				}
				send(response, 200, {
					tools: [...binding.schemas.values()],
					concluded: binding.concluded,
					...request.url === "/context" ? {
						system: binding.turn.system,
						context: context === void 0 ? void 0 : {
							...context,
							replay: context.replay.filter((group) => !group.compacted).map(({ before, messages }) => ({
								before,
								messages
							}))
						}
					} : {}
				});
				return;
			}
			if (typeof body.name !== "string" || !binding.schemas.has(body.name)) throw new BridgeError("Tool is not available in this DSH request", 403);
			if (typeof body.callId !== "string" || body.callId.length === 0 || body.callId.length > 200) throw new BridgeError("Invalid tool call identity", 400);
			if (body.arguments === null || typeof body.arguments !== "object" || Array.isArray(body.arguments)) throw new BridgeError("Tool arguments must be an object", 400);
			const payload = JSON.stringify([body.name, body.arguments]);
			const previous = binding.calls.get(body.callId);
			if (previous !== void 0 && previous.payload !== payload) throw new BridgeError("Tool call identity was reused with different input", 409);
			if (previous === void 0 && (binding.concluded || binding.calls.size >= 512)) throw new BridgeError("This DSH turn accepts no further tool calls", 409);
			const caller = new AbortController();
			const disconnect = () => {
				if (!response.writableFinished) caller.abort();
			};
			response.once("close", disconnect);
			try {
				let task = previous?.task;
				if (task === void 0) {
					const signal = AbortSignal.any([binding.signal, caller.signal]);
					task = binding.queue.then(() => this.#execute(binding, body.name, body.arguments, signal));
					binding.calls.set(body.callId, {
						payload,
						task
					});
					binding.queue = task.catch(() => void 0);
				}
				const result = await task;
				send(response, 200, {
					isError: result.isError,
					content: result.content,
					...result.error === void 0 ? {} : { error: result.error },
					...result.meta === void 0 ? {} : { meta: result.meta },
					...result.additionalContexts === void 0 ? {} : { additionalContexts: result.additionalContexts },
					...result.concludesTurn === true ? { concludesTurn: true } : {}
				});
			} finally {
				response.off("close", disconnect);
			}
		} catch (error) {
			send(response, error instanceof BridgeError ? error.status : 500, { error: error instanceof BridgeError ? error.message : "DSH tool bridge failed" });
		}
	}
	#ownsOpenStep(binding) {
		const owner = binding.owner;
		if (owner === void 0 || owner.host !== this.#host() || owner.host.agents.get(owner.agent.id) !== owner.agent) return false;
		const current = owner.host.position(owner.agent);
		return current?.turn === owner.position.turn && current.step === owner.position.step;
	}
	async #execute(binding, name$1, args, signal) {
		signal.throwIfAborted();
		const owner = binding.owner;
		if (owner === void 0 || binding.closed || binding.concluded || !this.#ownsOpenStep(binding)) throw new BridgeError("DSH tool owner is no longer available", 403);
		const { turn, step } = owner.position;
		const callId = `opencode-${randomUUID()}`;
		const argumentsText = JSON.stringify(args);
		const session = owner.agent.session;
		session.append("assistant/message", {
			turn,
			step,
			stream: [],
			message: createAssistantMessage({
				content: [{
					type: "tool-call",
					id: callId,
					name: name$1,
					arguments: argumentsText
				}],
				source: {
					provider: "opencode-free",
					model: binding.turn.model ?? "unknown"
				}
			})
		}, { surfaceOp: "append" });
		const call = session.append("tool/call", {
			turn,
			step,
			callId,
			name: name$1,
			arguments: argumentsText
		});
		let result;
		try {
			result = await owner.host.tools.execute({
				callId,
				name: name$1,
				arguments: args,
				agent: owner.agent,
				signal
			});
			if (signal.aborted && !result.isError) result = abortedResult();
		} catch {
			result = signal.aborted ? abortedResult() : {
				isError: true,
				content: [{
					type: "text",
					text: "Error: DSH tool execution failed"
				}]
			};
		}
		session.append("tool/result", {
			turn,
			step,
			message: createToolResultMessage({
				callId,
				content: result.content,
				isError: result.isError
			}),
			...result.error?.info === void 0 ? {} : { error: result.error.info },
			...result.meta === void 0 ? {} : { meta: result.meta }
		}, {
			surfaceOp: "append",
			sourceEventSeqs: [call.seq]
		});
		for (const message of result.additionalContexts ?? []) session.append("user/message", message, { surfaceOp: "append" });
		if (!result.isError && result.concludesTurn) binding.concluded = true;
		return result;
	}
};
function abortedResult() {
	return {
		isError: true,
		content: [{
			type: "text",
			text: "Error: DSH tool call cancelled"
		}],
		error: {
			message: "DSH tool call cancelled",
			info: {
				name: "AbortError",
				code: "ABORTED"
			}
		}
	};
}
async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new BridgeError("Request body is too large", 413);
		chunks.push(chunk);
	}
	let body;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new BridgeError("Invalid JSON", 400);
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BridgeError("Expected a JSON object", 400);
	return body;
}
function send(response, status, body) {
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store"
	});
	response.end(JSON.stringify(body));
}

//#endregion
//#region src/tool-bridge-environment.ts
/** Extend the managed child's config without writing a project's config file. */
async function toolBridgeEnvironment(bridge, pluginDirectory) {
	const address = await bridge.start();
	let config = {};
	if (process.env.OPENCODE_CONFIG_CONTENT !== void 0) {
		const parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
		config = parsed;
	}
	if (config.plugins !== void 0 && !Array.isArray(config.plugins)) throw new Error("OpenCode plugins must be an array");
	return {
		DSH_OPENCODE_BRIDGE_URL: address.baseUrl,
		DSH_OPENCODE_BRIDGE_TOKEN: address.token,
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			...config,
			plugins: [...config.plugins ?? [], pluginDirectory]
		})
	};
}

//#endregion
//#region src/companion-runtime.ts
/** Keep OpenCode's file watcher outside the package pnpm replaces on update. */
var OpenCodeCompanion = class {
	#source;
	#parent;
	#staging;
	#disposing;
	#disposed = false;
	constructor(sourceDirectory, parentDirectory = tmpdir()) {
		this.#source = sourceDirectory;
		this.#parent = parentDirectory;
	}
	/** All managed servers use the same immutable copy for this plugin load. */
	directory() {
		if (this.#disposed) return Promise.reject(/* @__PURE__ */ new Error("OpenCode companion has been disposed"));
		this.#staging ??= this.#stage().catch((error) => {
			this.#staging = void 0;
			throw error;
		});
		return this.#staging;
	}
	async #stage() {
		const directory = await mkdtemp(join(this.#parent, "deep-opencode-companion-"));
		try {
			await copyFile(join(this.#source, "index.js"), join(directory, "index.js"));
			await writeFile(join(directory, "package.json"), "{\"private\":true,\"type\":\"module\"}\n", "utf8");
			return directory;
		} catch (error) {
			await rm(directory, {
				recursive: true,
				force: true
			});
			throw error;
		}
	}
	/** Called after managed processes exit, including any staging in flight. */
	dispose() {
		this.#disposed = true;
		this.#disposing ??= this.#remove();
		return this.#disposing;
	}
	async #remove() {
		const directory = await this.#staging?.catch(() => void 0);
		if (directory !== void 0) await rm(directory, {
			recursive: true,
			force: true
		});
	}
};

//#endregion
//#region src/index.ts
const name = "dsh-deep-opencode";
const inject = ["llm", "sessions"];
/** The provider route this plugin owns; the catalogue validates against it. */
const ROUTE = OPENCODE_FREE_ROUTE;
/**
* Writes the discovery report where a user can read it.
*
* Desktop surfaces keep the plugin log inside the app, so an empty model picker
* has no explanation available otherwise. The write never fails the mount: a
* read-only harness home simply means no file.
*
* @returns the written path, or `undefined` when it could not be written.
*/
async function writeReport(relative, report) {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const target = relative === void 0 ? join(home, "deep-opencode", "diagnostics.json") : isAbsolute(relative) ? relative : join(home, relative);
	try {
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, `${JSON.stringify(report, void 0, 2)}\n`, "utf8");
		return target;
	} catch {
		return;
	}
}
const DEFAULTS = {
	opencodeCommand: "opencode",
	host: "127.0.0.1",
	port: 0,
	startupTimeoutMs: 12e4,
	reuseSessions: true,
	maxSessionMappings: 32,
	sessionIdleTtlMs: 18e5,
	sessionTurnGraceMs: 6e5,
	turnTimeoutMs: 9e5,
	catalogTimeoutMs: 6e4,
	logDiagnostics: true,
	forwardHarnessContext: false,
	bridgeHarnessTools: true
};
function resolveConfig(config) {
	return {
		...DEFAULTS,
		...config
	};
}
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	let toolHost;
	const toolBridge = new HarnessToolBridge(() => toolHost);
	const companion = new OpenCodeCompanion(fileURLToPath(new URL("./opencode/", import.meta.url)));
	const pool = new OpenCodeServerPool(resolved, async () => toolBridgeEnvironment(toolBridge, await companion.directory()));
	const fallbackDirectory = resolved.cwd ?? process.cwd();
	const resolveDirectory = (sessionId) => {
		if (sessionId === void 0) return void 0;
		try {
			return ctx.sessions.get(sessionId)?.header.cwd;
		} catch {
			return;
		}
	};
	const registry = new SessionRegistry({
		maxSessions: resolved.maxSessionMappings,
		idleTtlMs: resolved.sessionIdleTtlMs,
		turnGraceMs: resolved.sessionTurnGraceMs
	});
	let approvalHost;
	ctx.inject(["agents", "approval"], (scope) => {
		const host = scope;
		approvalHost = host;
		scope.effect(() => () => {
			if (approvalHost === host) approvalHost = void 0;
		});
	});
	if (resolved.bridgeHarnessTools) ctx.inject(["agents", "tools"], (scope) => {
		const services = scope;
		const positions = /* @__PURE__ */ new Map();
		services.on("session/event", (session, event) => {
			if (event.type === "step/start" && event.data.turn !== void 0 && event.data.step !== void 0) positions.set(session.id, {
				turn: event.data.turn,
				step: event.data.step
			});
			if (event.type === "step/end" || event.type === "turn/end" || event.type === "session/end") positions.delete(session.id);
		});
		const host = {
			agents: services.agents,
			tools: services.tools,
			position: (agent) => positions.get(agent.id)
		};
		toolHost = host;
		scope.effect(() => () => {
			if (toolHost === host) toolHost = void 0;
			positions.clear();
		});
	});
	const adapter = new OpenCodeFreeAdapter(pool, fallbackDirectory, resolveDirectory, resolved.turnTimeoutMs, resolved.catalogTimeoutMs, registry, resolved.reuseSessions, resolved.forwardHarnessContext, {
		permissions: resolved.sessionPermissions,
		agent: resolved.nativeAgent,
		toolBridge,
		bridgeHarnessTools: resolved.bridgeHarnessTools,
		onEvent: (event) => ctx.parallel("deep-opencode/event", event),
		onPermission: async (event) => {
			return await ctx.serial("deep-opencode/permission", event) ?? requestHarnessPermission(approvalHost, event);
		},
		onForm: (event) => ctx.serial("deep-opencode/form", event)
	});
	const discoveryServer = pool.forDirectory(void 0, fallbackDirectory);
	const client = new OpenCodeClient(discoveryServer);
	const unregister = ctx.llm.registerAdapter([ROUTE], adapter);
	ctx.effect(() => () => {
		clearCatalog();
		unregister();
	});
	if (resolved.logDiagnostics) (async () => {
		let report;
		try {
			const info = await client.info();
			const models = await refreshCatalog(client, resolved.catalogTimeoutMs);
			const names = models.map((model) => model.id).join(", ");
			report = {
				status: models.length > 0 ? "ok" : "no-models",
				opencodeCommand: resolved.opencodeCommand,
				resolvedBinary: discoveryServer.binary ?? null,
				opencodeVersion: info.version ?? null,
				baseUrl: discoveryServer.baseUrl ?? null,
				modelCount: models.length,
				models: models.map((model) => model.id)
			};
			ctx.logger.info(`deep-opencode: ${report.resolvedBinary} v${info.version ?? "unknown"} on ${discoveryServer.baseUrl ?? "pending"}; ${models.length} free model(s): ${names.length > 0 ? names : "none"}`);
		} catch (error) {
			const message = error instanceof OpenCodeRequestError ? error.message : String(error);
			report = {
				status: "failed",
				opencodeCommand: resolved.opencodeCommand,
				resolvedBinary: discoveryServer.binary ?? null,
				error: message
			};
			ctx.logger.warn(`deep-opencode: model discovery failed: ${message}`);
		}
		const written = await writeReport(resolved.diagnosticsPath, report);
		if (written !== void 0) ctx.logger.info(`deep-opencode: diagnostics written to ${written}`);
	})();
	{
		let cancelled = false;
		(async () => {
			for (const delay of [
				0,
				5e3,
				15e3
			]) {
				if (cancelled) return;
				if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
				if (cancelled) return;
				try {
					if ((await refreshCatalog(client, resolved.catalogTimeoutMs)).length > 0) return;
				} catch {}
			}
		})();
		ctx.effect(() => () => {
			cancelled = true;
		});
	}
	let sweep;
	ctx.effect(() => {
		sweep = setInterval(() => {
			registry.reclaim().then((ids) => registry.deleteSessions(ids)).catch((error) => {
				ctx.logger.warn(`deep-opencode: session reclamation failed: ${String(error)}`);
			});
		}, resolved.sessionIdleTtlMs > 0 ? resolved.sessionIdleTtlMs : 6e4);
		sweep.unref?.();
		return () => {
			if (sweep !== void 0) clearInterval(sweep);
			sweep = void 0;
		};
	});
	ctx.effect(() => () => {
		return adapter.dispose().then(() => registry.deleteSessions(registry.drain())).finally(async () => {
			try {
				await pool.stopAll();
			} finally {
				try {
					await toolBridge.dispose();
				} finally {
					await companion.dispose();
				}
			}
		}).catch((error) => ctx.logger.warn(`deep-opencode: shutdown failed: ${String(error)}`));
	});
}

//#endregion
export { HarnessToolBridge, LlmError, OPENCODE_FREE_ROUTE, OPENCODE_PROVIDER, OpenCodeClient, OpenCodeCompanion, OpenCodeFreeAdapter, OpenCodeRequestError, OpenCodeServer, OpenCodeServerPool, ROUTE, SessionRegistry, apply, authorizationHeader, clearCatalog, deleteReclaimed, digest, inject, isFreeModel, listModels, name, planTurn, refreshCatalog, requestHarnessPermission, toFreeModel, toolBridgeEnvironment, translateEvents };