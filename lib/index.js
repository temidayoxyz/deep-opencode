import { LlmAdapter, LlmError, LlmError as LlmError$1 } from "@deepseek-ai/dsh-llm";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, statSync } from "node:fs";

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
	constructor(config) {
		this.#config = config;
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
		if (this.#address !== void 0) return this.#address;
		this.#starting ??= this.#launch().finally(() => {
			this.#starting = void 0;
		});
		this.#address = await this.#starting;
		return this.#address;
	}
	async #launch() {
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
		this.#binary = spawnedBinary;
		this.#child = child;
		let buffered = "";
		const onOutput = (chunk) => {
			buffered += chunk.toString("utf8");
		};
		child.stdout?.on("data", onOutput);
		child.stderr?.on("data", onOutput);
		const exited = once(child, "exit");
		const deadline = new Promise((_, reject) => {
			setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`\`${spawnedBinary}\` did not report a listening URL within ${startupTimeoutMs}ms`));
			}, startupTimeoutMs).unref?.();
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
			child.stdout?.off("data", onOutput);
			child.stderr?.off("data", onOutput);
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
		const child = this.#child;
		this.#child = void 0;
		this.#address = void 0;
		if (child === void 0 || child.exitCode !== null) return;
		child.kill("SIGTERM");
		const exited = once(child, "exit").catch(() => void 0);
		const grace = new Promise((resolve) => {
			setTimeout(resolve, 3e3).unref?.();
		});
		await Promise.race([exited, grace]);
		if (child.exitCode === null) child.kill("SIGKILL");
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
	constructor(config) {
		this.#config = config;
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
		const chosen = directory !== void 0 && isDirectory(directory) ? directory : fallback;
		const key = process.platform === "win32" ? chosen.toLowerCase() : chosen;
		const existing = this.#servers.get(key);
		if (existing !== void 0) return existing;
		const server = new OpenCodeServer({
			...this.#config,
			cwd: chosen
		});
		this.#servers.set(key, server);
		return server;
	}
	/** The directories that currently own a server. */
	get directories() {
		return [...this.#servers.values()].map((server) => server.cwd).filter((value) => value !== void 0);
	}
	/** Stops every server, for plugin unload. */
	async stopAll() {
		const servers = [...this.#servers.values()];
		this.#servers.clear();
		await Promise.all(servers.map((server) => server.stop()));
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
	sessionPrompt: (id) => `/api/session/${id}/prompt`,
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
	async createSession() {
		const session = await this.#json(ROUTES.sessionCreate, {
			method: "POST",
			body: "{}"
		});
		if (session?.id === void 0) throw new OpenCodeRequestError("OpenCode created a session without an id", "PROTOCOL");
		return session.id;
	}
	async deleteSession(id) {
		try {
			await this.#json(ROUTES.sessionDelete(id), { method: "DELETE" });
		} catch {}
	}
	/**
	* `POST /api/session/{id}/model` — pins the session's model.
	*
	* The body is `{model: {id, providerID}}`; the server rejects a flat string
	* and a `modelID` key, so both field names are load-bearing.
	*/
	async setModel(id, model, providerID) {
		await this.#json(ROUTES.sessionModel(id), {
			method: "POST",
			body: JSON.stringify({ model: {
				id: model,
				providerID
			} })
		});
	}
	/** `POST /api/session/{id}/prompt` — enqueues one turn; output arrives on the event stream. */
	async prompt(id, text) {
		await this.#json(ROUTES.sessionPrompt(id), {
			method: "POST",
			body: JSON.stringify({ text })
		});
	}
	/** `POST /api/session/{id}/interrupt` — the cancellation path for an in-flight turn. */
	async interrupt(id) {
		try {
			await this.#json(ROUTES.sessionInterrupt(id), { method: "POST" });
		} catch {}
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
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					for (const line of frame.split("\n")) {
						if (!line.startsWith("data:")) continue;
						const payload = line.slice(5).trim();
						if (payload.length === 0) continue;
						try {
							yield JSON.parse(payload);
						} catch {}
					}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel().catch(() => void 0);
		}
	}
};

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
	const cost = entry.cost?.[0];
	return cost !== void 0 && (cost.input ?? 1) === 0;
}
/** Projects one catalogue entry onto the route's model description. */
function toFreeModel(entry) {
	const context = entry.limit?.context;
	return {
		provider: OPENCODE_FREE_ROUTE,
		id: entry.id,
		name: entry.name ?? entry.id,
		inputModalities: readModalities(entry),
		context: context === void 0 ? void 0 : { contextWindow: context },
		tools: entry.capabilities?.tools === true
	};
}
/** Maps OpenCode's input modality strings onto the harness vocabulary. */
function readModalities(entry) {
	const input = entry.capabilities?.input;
	if (input === void 0) return void 0;
	const modalities = [];
	for (const value of input) {
		if (value === "text") modalities.push("text");
		if (value === "image") modalities.push("image");
	}
	return modalities.length > 0 ? modalities : void 0;
}

//#endregion
//#region src/discovery.ts
/** The models this route currently offers. */
let cached = [];
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
	const deadline = Date.now() + Math.max(timeoutMs, 0);
	for (;;) {
		const entries = await client.listModels();
		if (entries.length > 0) {
			cached = entries.filter(isFreeModel).map(toFreeModel);
			return cached;
		}
		if (Date.now() >= deadline) {
			cached = [];
			return cached;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, CATALOG_POLL_INTERVAL_MS).unref?.();
		});
	}
}
/** Empties the catalogue, called when the route is released. */
function clearCatalog() {
	cached = [];
}

//#endregion
//#region src/prompt.ts
/** Labels a transcript entry by who said it. */
function label(role) {
	return role === "user" ? "User" : "Assistant";
}
/**
* The one-time context a provider session is opened with.
*
* It is not repeated per turn: the provider applies it once and keeps it, so
* resending would restate the system prompt and the capability list on every
* exchange.
*
* @param options - the assembled request
* @returns the preamble text, empty when there is nothing to declare
*/
function buildPreamble(options) {
	const sections = [];
	if (options.system !== void 0 && options.system.length > 0) sections.push(options.system);
	const tools = options.tools ?? [];
	if (tools.length > 0) sections.push(`Available capabilities: ${tools.map((tool) => tool.name).join(", ")}. Use the tools you have been given rather than describing what you would do.`);
	return sections.join("\n\n");
}
/**
* The single instruction sent when there is no mapped provider session.
*
* The conversation is flattened into one labelled transcript rather than sent
* as structured history, because OpenCode's prompt endpoint accepts one text
* field and runs its own agent turn on top of it.
*
* @param options - the assembled request
* @param messages - the conversation to include, in order
* @returns the prompt text, empty when nothing is worth sending
*/
function buildTranscriptPrompt(options, messages) {
	const sections = [];
	const preamble = buildPreamble(options);
	if (preamble.length > 0) sections.push(preamble);
	const transcript = messages.filter((message) => message.text.length > 0).map((message) => `${label(message.role)}: ${message.text}`);
	sections.push(transcript.join("\n\n"));
	return sections.filter((section) => section.length > 0).join("\n\n");
}
/**
* The single new message sent into an existing provider session.
*
* One prompt carries one turn, so when several messages are new they are sent
* as one labelled block: OpenCode would treat separate prompts as separate user
* turns, and the harness has already decided these belong to one.
*
* @param options - the assembled request
* @param messages - only what is new since the last turn
* @param includePreamble - whether this turn also opens the conversation
* @returns the prompt text, empty when there is nothing new to say
*/
function buildDeltaPrompt(options, messages, includePreamble) {
	const parts = [];
	if (includePreamble) {
		const preamble = buildPreamble(options);
		if (preamble.length > 0) parts.push(preamble);
	}
	for (const message of messages) if (message.text.length > 0) parts.push(message.text);
	return parts.join("\n\n");
}

//#endregion
//#region src/session-registry.ts
const DEFAULTS$1 = {
	maxSessions: 32,
	idleTtlMs: 30 * 6e4,
	turnGraceMs: 10 * 6e4
};
/** Flattens one harness message's content blocks to text. */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) if (block !== null && typeof block === "object" && block.type === "text") {
		const text = block.text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("");
}
/** The two roles OpenCode can be told about; everything else is not conversation. */
function isConversible(message) {
	return message.role === "user" || message.role === "assistant";
}
/** Projects a request's messages into identity, role and text. */
function digest(options) {
	const messages = [];
	for (const message of options.messages) {
		if (!isConversible(message)) continue;
		messages.push({
			id: message.id,
			role: message.role,
			text: textOf(message.content)
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
	const delta = messages.slice(anchor + 1).filter((message) => message.text.length > 0);
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
		const run = (this.#entries.get(sessionId)?.queue ?? Promise.resolve()).then(() => this.#runEntry(sessionId, task), () => this.#runEntry(sessionId, task));
		const existing = this.#entries.get(sessionId) ?? this.#insertPlaceholder(sessionId);
		existing.queue = run.then(() => void 0, () => void 0);
		return await run;
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
			queue: Promise.resolve()
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
		});
		return this.#enforceCountBound();
	}
	/** Drops least-recently-used entries past the count bound. */
	#enforceCountBound() {
		const evicted = [];
		if (this.#entries.size <= this.#policy.maxSessions) return evicted;
		const byAge = [...this.#entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		for (const [sessionId, entry] of byAge.slice(0, this.#entries.size - this.#policy.maxSessions)) {
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
	* An entry mid-turn is protected by `turnGraceMs` from the last touch, so
	* reclamation cannot delete a provider session a running turn is using.
	*
	* @returns the provider sessions to delete, for the caller to remove
	*/
	async reclaim(now = Date.now()) {
		const expired = [];
		for (const [sessionId, entry] of this.#entries) {
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
	"session.execution.aborted"
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
* emitted after `finish`, block indexes follow the provider's first-seen
* `ordinal`, and failures end the stream in a terminal `finish` rather than
* throwing mid-stream.
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
/**
* Bounds one queue drain.
*
* The provider owns the turn, so a turn that never settles would hold the dsh
* step open indefinitely. A non-positive `timeoutMs` disables the bound.
*/
async function* withTimeout(queue, timeoutMs) {
	if (timeoutMs <= 0) {
		yield* queue;
		return;
	}
	const iterator = queue[Symbol.asyncIterator]();
	let timer;
	const expiry = new Promise((_, reject) => {
		timer = setTimeout(() => {
			reject(new LlmError$1(`opencode-free turn did not settle within ${timeoutMs}ms`, "TIMEOUT"));
		}, timeoutMs);
		timer.unref?.();
	});
	try {
		while (true) {
			const result = await Promise.race([iterator.next(), expiry]);
			if (result.done === true) return;
			yield result.value;
		}
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
function freshBlocks() {
	return {
		next: 0,
		indexes: /* @__PURE__ */ new Map(),
		assistantMessageID: void 0
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
	constructor(pool, fallbackDirectory, resolveDirectory, turnTimeoutMs, catalogTimeoutMs, registry, reuseSessions = true) {
		super();
		this.#pool = pool;
		this.#fallbackDirectory = fallbackDirectory;
		this.#resolveDirectory = resolveDirectory;
		this.#registry = registry;
		this.#reuseSessions = reuseSessions;
		this.#turnTimeoutMs = turnTimeoutMs;
		this.#catalogTimeoutMs = catalogTimeoutMs;
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
		try {
			return await refreshCatalog(this.#clientFor(void 0), this.#catalogTimeoutMs);
		} catch {
			return [];
		}
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
	* because OpenCode fixes a session's directory when its process starts.
	*/
	async *stream(options) {
		const conversation = digest(options);
		const client = this.#clientFor(options.sessionId);
		const mapped = options.sessionId !== void 0 && this.#reuseSessions;
		const registry = this.#registry;
		const run = async () => {
			const digestOf = conversation;
			if (!mapped || registry === void 0) {
				const text$1 = buildTranscriptPrompt(options, digestOf);
				if (text$1.length === 0) throw new LlmError$1("opencode-free received a request with no text to send", "INVALID_REQUEST");
				const created = await client.createSession();
				await client.setModel(created, options.model, OPENCODE_PROVIDER);
				return {
					providerSessionId: created,
					text: text$1
				};
			}
			return await registry.withEntry(options.sessionId, async ({ entry, opencodeSessionId }) => {
				const plan = planTurn(digestOf, entry.sentThrough, entry.preambleSent);
				let providerSessionId = opencodeSessionId;
				if (providerSessionId === "" || plan.resendAll) {
					const previous = providerSessionId;
					providerSessionId = await client.createSession();
					entry.opencodeSessionId = providerSessionId;
					entry.sentThrough = void 0;
					entry.sentCount = 0;
					entry.preambleSent = false;
					if (previous !== "") await client.deleteSession(previous);
				}
				await client.setModel(providerSessionId, options.model, OPENCODE_PROVIDER);
				const text$1 = plan.resendAll || plan.messages.length === 0 ? buildTranscriptPrompt(options, digestOf) : buildDeltaPrompt(options, plan.messages, plan.sendPreamble);
				if (text$1.length === 0) throw new LlmError$1("opencode-free received a request with no text to send", "INVALID_REQUEST");
				const last = plan.messages.at(-1);
				if (last?.id !== void 0) entry.sentThrough = last.id;
				entry.sentCount += plan.messages.length;
				if (plan.sendPreamble) entry.preambleSent = true;
				return {
					providerSessionId,
					text: text$1
				};
			});
		};
		let prepared;
		try {
			prepared = await run();
		} catch (error) {
			throw toLlmError(error);
		}
		const text = prepared.text;
		const sessionId = prepared.providerSessionId;
		const blocks = freshBlocks();
		let usageEmitted = false;
		let finished = false;
		try {
			const queue = new AsyncQueue();
			const subscription = new AbortController();
			const onCallerAbort = () => {
				subscription.abort();
			};
			if (options.signal !== void 0) if (options.signal.aborted) subscription.abort();
			else options.signal.addEventListener("abort", onCallerAbort, { once: true });
			const reader = client.events(subscription.signal)[Symbol.asyncIterator]();
			let pending = reader.next();
			/** Drains one frame's chunks into the queue. */
			const consume = (event) => {
				if (event.data?.sessionID !== void 0 && event.data.sessionID !== sessionId) return;
				for (const chunk of translate(event, blocks)) {
					if (chunk.type === "usage") usageEmitted = true;
					if (chunk.type === "finish") finished = true;
					queue.push(chunk);
				}
			};
			try {
				const opened = await pending;
				if (opened.done !== true) consume(opened.value);
				await client.prompt(sessionId, text);
				pending = reader.next();
				(async () => {
					try {
						while (!finished) {
							const step = await pending;
							if (step.done === true) break;
							consume(step.value);
							pending = reader.next();
						}
					} catch (error) {
						if (!subscription.signal.aborted) queue.fail(toLlmError(error));
					} finally {
						queue.close();
					}
				})();
				for await (const chunk of withTimeout(queue, this.#turnTimeoutMs)) {
					yield chunk;
					if (chunk.type === "finish") break;
				}
			} finally {
				subscription.abort();
				options.signal?.removeEventListener("abort", onCallerAbort);
				await reader.return?.(void 0);
			}
		} catch (error) {
			throw toLlmError(error);
		} finally {
			if (!mapped) await client.deleteSession(sessionId);
		}
		if (!finished) throw new LlmError$1("OpenCode ended the turn without a terminal event", "PROTOCOL");
		if (!usageEmitted) throw new LlmError$1("OpenCode ended the turn without token usage", "PROTOCOL");
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
			blocks.next = 0;
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
		if (data.tokens !== void 0) yield {
			type: "usage",
			usage: toUsage(data.tokens)
		};
		yield {
			type: "finish",
			reason: toFinishReason(data.finish, data.rawFinish)
		};
		return;
	}
	if (EXECUTION_FAILED.includes(type)) {
		yield {
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: typeof data.message === "string" ? data.message : "OpenCode reported a failed execution",
					code: "PROVIDER"
				}
			}
		};
		return;
	}
	if (type === EXECUTION_SUCCEEDED) return;
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
	logDiagnostics: true
};
function resolveConfig(config) {
	return {
		...DEFAULTS,
		...config
	};
}
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const pool = new OpenCodeServerPool(resolved);
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
	const adapter = new OpenCodeFreeAdapter(pool, fallbackDirectory, resolveDirectory, resolved.turnTimeoutMs, resolved.catalogTimeoutMs, registry, resolved.reuseSessions);
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
	let sweep;
	ctx.effect(() => {
		sweep = setInterval(() => {
			registry.reclaim().then((ids) => deleteReclaimed(client, ids));
		}, resolved.sessionIdleTtlMs);
		sweep.unref?.();
		return () => {
			if (sweep !== void 0) clearInterval(sweep);
			sweep = void 0;
		};
	});
	ctx.effect(() => () => {
		pool.stopAll();
	});
}

//#endregion
export { LlmError, OPENCODE_FREE_ROUTE, OPENCODE_PROVIDER, OpenCodeClient, OpenCodeFreeAdapter, OpenCodeRequestError, OpenCodeServer, OpenCodeServerPool, ROUTE, SessionRegistry, apply, authorizationHeader, deleteReclaimed, digest, inject, isFreeModel, listModels, name, planTurn, refreshCatalog, toFreeModel, translateEvents };