---
description: "OpenCode's free-tier models inside DeepSeek Harness, served by a local OpenCode process."
kind: "group"
---

# dsh-deep-opencode

English | [中文](README.zh.md)

Use OpenCode's **free-tier models** inside DeepSeek Harness. The harness
already reads the `opencode` and `opencode-go` providers from the shared
models.dev catalogue, and those work — but only with an OpenCode API key. Their
free models fail, because the gateway refuses them for any client that is not
OpenCode:

```text
OpenCode's free tier can only be used from within OpenCode
```

This plugin adds a separate provider route, `opencode-free`, that reaches those
same free models. It starts a real `opencode serve` process and asks *that*
process to run each turn, so the request genuinely originates from OpenCode and
the free models resolve. No API key is involved. This is the same arrangement
[OpenChamber](https://github.com/openchamber/openchamber) uses.

## Install

Requires the OpenCode v2 CLI on your `PATH` (`opencode --version`).

From the npm registry, once published:

```sh
dsh plugin add dsh-deep-opencode
```

From GitHub:

```sh
dsh plugin add https://github.com/temidayoxyz/deep-opencode
```

The built entry point is committed, so a GitHub install needs no build step —
pnpm refuses to run a git dependency's install scripts, and the package has no
`prepare` script to run.

To work on it locally instead, clone and install from the path:

```sh
git clone https://github.com/temidayoxyz/deep-opencode.git
cd deep-opencode && npm install && npm run build
dsh plugin add D:/path/to/deep-opencode
```

Or add it to a profile's `cordis.patch.yml`:

```yaml
- name: dsh-deep-opencode
```

## Use

Pick provider **`opencode-free`** in the model selector. The models listed are
whatever your installed OpenCode version currently serves for free — read from
the running server, not pinned in this plugin, so a newly added free model shows
up on its own and a retired one disappears on its own.

As of OpenCode v2.0.18 that is: Big Pickle, Ling 3.0 Flash Fin Free,
LongCat 2.5 Preview Free, MiMo-V2.6-Flash Free, Muse Spark 1.3 Free,
Nemotron 3.5 Lightning Free, Nemotron 3 Ultra Free, and Space Bunny Free.

## Configuration

Every deployment-varying value is a `cordis.yml` field:

| Field | Default | Meaning |
|---|---|---|
| `opencodeCommand` | `opencode` | Executable name or path, resolved through `PATH`. |
| `cwd` | harness working directory | Project directory for a session that has none, and where the model catalogue is read. A session with a project always uses its own. |
| `host` | `127.0.0.1` | Loopback host the managed server binds. |
| `port` | `0` | Port for the managed server; `0` lets the OS choose a free one. |
| `startupTimeoutMs` | `120000` | Deadline for the server to report its listening URL. |
| `turnTimeoutMs` | `900000` | Bound on one delegated turn; `0` disables it. |
| `reuseSessions` | `true` | Keep one OpenCode session per Harness session so turns recall each other. `false` restores one provider session per request. |
| `maxSessionMappings` | `32` | Maximum Harness sessions mapped to a provider session at once; the least recently used is evicted. |
| `sessionIdleTtlMs` | `1800000` | Idle lifetime of a mapping; `0` disables idle reclamation. |
| `sessionTurnGraceMs` | `600000` | Reclaim grace window protecting a turn in flight. |
| `logDiagnostics` | `true` | Report the managed server's version and discovered models on load. |
| `catalogTimeoutMs` | `60000` | Wait for a cold server to populate its model catalogue. |
| `diagnosticsPath` | `deep-opencode/diagnostics.json` under Harness home | Discovery report location. |
| `forwardHarnessContext` | `false` | Include a capability-name summary in the model's system context. Harness instructions and context are always forwarded through the companion. |
| `bridgeHarnessTools` | `true` | Make the current request's DSH tools callable inside OpenCode through DSH's normal executor. |
| `sessionPermissions` | OpenCode defaults | Native permission rules for new sessions, shaped as `{ action, resource, effect }`. |
| `nativeAgent` | OpenCode default | Native agent selected when a delegated session is created. |

```yaml
- name: dsh-deep-opencode
  config:
    opencodeCommand: opencode
    turnTimeoutMs: 1200000
```

## Model Experience

### Delegated model requests

#### What the model sees

Each native user prompt contains the human's exact text, with no `User:` label,
preamble, runtime snapshot, or skill catalogue attached. The adapter uses DSH's
message provenance to distinguish human input from plugin context; text that
the human actually types is preserved, including literal reminder tags.

The bundled OpenCode companion supplies the Harness system prompt and working
directory separately. Skill catalogues, runtime snapshots, and other injected
messages enter the model context with their original roles without becoming
native user messages. The companion also restores initial or rebuilt history
as separate user and assistant messages. Follow-ups keep OpenCode's native
history, including its own answers and tool results. Updating injected context
does not reset that conversation. Producer-only and auxiliary requests use a
native synthetic trigger rather than impersonating human input.

With `bridgeHarnessTools: true` (the default), main turns also receive the exact
DSH tool schemas. The native agent calls a DSH
plugin tool by passing its name and argument object to `dsh_call`; `dsh_list`
refreshes the tools available to that request. No manual MCP setup is needed.
`forwardHarnessContext` adds a capability-name summary to system context and
can stay `false`. Disabling `bridgeHarnessTools` keeps context forwarding active.

#### Agent execution and plugin integration

One Harness request now follows the **whole OpenCode agent execution**. A
`session.step.ended` event records a model step; a step ending in `tool-calls`
continues inside OpenCode. The adapter emits one final usage total and one
finish when `session.execution.succeeded` arrives. Text and reasoning from
different model steps retain distinct block indexes in the Harness response.

Harness cancellation interrupts the provider agent, rather than just closing
the event stream. The turn deadline includes queueing, startup, model selection,
prompt admission, interactive requests, and response streaming. A failed or
interrupted run is rebuilt from the Harness transcript on the next turn.

Other Host plugins can connect to these Cordis events:

| Event | Handler contract |
|---|---|
| `deep-opencode/event` | Observe native events, including tool calls, progress, results, and failures. |
| `deep-opencode/permission` | Return `once`, `always`, or `reject` after obtaining the user's decision. |
| `deep-opencode/form` | Return the native form answer object after collecting the user's answers. |

Each handler receives `{ harnessSessionId, providerSessionId, event, signal }`.
Permission and form handlers are awaited and cancelled with the turn. An explicit
permission handler takes precedence; otherwise the plugin uses the Host's
`agents` and `approval` services to ask through DSH's existing approval UI and
policies, using the live agent for the Harness session. An `allowed-once` answer
grants only that native request. If no service or handler can answer, the request
ends with `INTERACTION_REQUIRED` instead of silently waiting until timeout.
Forms require a handler. `sessionPermissions` can explicitly grant or deny native
actions for a deployment that already has an agreed policy.

The bundled native companion runs DSH plugin tools through the live Host's
`tools.execute` service with the exact Harness agent. DSH's schema validation,
tool hooks, guards, policies, and approval flow apply to each call. Calls and
results are appended to the canonical Harness session journal, including
presentation metadata and additional context. The outer LLM stream does not
emit those already executed calls, preventing duplicate dispatch.

The bridge binds only the current request's tools to its provider session and
open Harness step. It rejects calls after cancellation, step closure, or Host
unload; serializes calls; deduplicates provider call IDs; and drains owned tool
work before releasing the step. It uses an authenticated loopback listener and
adds the companion to the managed child's configuration without changing
project or global config files. Auxiliary requests receive context without
DSH tool access. Replayed history also participates in native compaction.
If a main request declares DSH tools but its live Host
services are missing, it fails with `NO_TOOL_BRIDGE` instead of pretending the
tools are available. Set `bridgeHarnessTools: false` to use only native tools.

Native OpenCode tools, project instructions, configured skills, and MCP
servers continue to run according to the installed OpenCode configuration.
Set `nativeAgent` when an installed OpenCode plugin requires a particular agent;
otherwise OpenCode's configured default remains in control.

#### Token effect

Model input includes the Harness system prompt, injected context, and scoped
tool catalogue even though these are absent from native user bubbles. A large
skill catalogue still consumes input tokens. Usage counts the entire native
execution, including its tool loops, through the provider's token totals.

#### KV Cache effect

Follow-ups reuse OpenCode's native history. Cache hits depend on the provider
and the resulting model context: refreshed Harness context can change the
prefix even when the native session is reused. Rewriting past conversation
creates a new native session and restores history through the companion.

## Known Limitations and Deferred Work

- **Continuity is held by the provider, not the log.** A turn sends only what is
  new, because OpenCode keeps the conversation itself. If Harness rewrites a
  past message — a compaction, a fork — the cursor loses its anchor and the whole
  conversation is replayed into a fresh provider session. Continuity then resets
  to what was replayed.
- **A fork starts a new provider session.** The inherited Harness transcript is
  replayed into that fresh session on its first request.
- **Token accounting counts the whole conversation each turn.** The provider
  holds the history, so per-turn input tokens reflect everything it re-reads,
  while the Harness log only records what was sent.
- **OpenCode owns the delegated agent loop.** DSH retains its session log and
  turn lifecycle and executes bridged plugin tools through its own runtime.
  Native OpenCode tools use OpenCode's configuration and permission flow.
- **One managed server per project directory.** Each project gets its own
  `opencode serve`, and session creation passes the directory through OpenCode's
  native `location` field. Several projects cost several OpenCode processes.
- **A session with no project directory falls back** to the `cwd` config field,
  or the harness's own working directory when that is unset.
- **Replayed history is model context.** Inherited messages are restored with
  their roles through the companion rather than inserted into native storage.
  Existing native sessions created by older versions retain their saved text;
  start a new Harness chat after updating to get a clean native transcript.
- **Standalone adapter callers must configure the companion transport** to
  forward Harness instructions, injected context, or replayed history. Missing
  transport fails with `NO_TOOL_BRIDGE`; the normal Cordis plugin configures it
  automatically, including when DSH tools are disabled.
- **Only the free models are offered.** A paid OpenCode model is reachable
  through the harness's own `opencode`/`opencode-go` providers with a key; this
  route deliberately lists only zero-cost models, because a paid model reached
  through a free route would be a real charge.
- **A model the installed OpenCode does not serve cannot be used here**, even if
  a catalogue lists it as free. Availability is whatever the running server
  reports, which is why the list is discovered rather than hard-coded.
- **Native tool events use the event hook.** Bridged DSH calls and results are
  recorded in Harness's journal. Native OpenCode tool calls are observable
  through `deep-opencode/event`; they are not replayed as DSH tool calls.
- **No reasoning-effort selection.** OpenCode chooses its own reasoning settings;
  this route does not expose the provider's effort levels.
- **Image inputs are not forwarded.** Only text reaches the delegated turn, so a
  model that accepts images is still driven with text here.
- **A missing or broken OpenCode install fails at request time**, not at mount: the
  route stays registered so a repaired install works without reloading the
  profile. Load-time discovery failure is logged as a warning.
- **Reloading interrupts in-flight turns.** The plugin interrupts delegated
  runs, deletes its mapped sessions, then stops its managed servers.

## Verification

```sh
npm run typecheck
npm run build
npm run verify:offline
npm run verify:server
npm run verify:context
npm run verify:agent
npm run verify:bridge
```

Offline checks include regression coverage for session serialization, failed
prompt replay, deadlines, idle reclamation, mapping limits, assistant history,
cancellation, complete tool loops, interactive requests, DSH approval decisions,
auxiliary calls, stale discovery after unload, authenticated tool transport,
scope isolation, policy denials, journal events, exactly-once dispatch, step
closure, cancellation, conclusion, and companion registration. `verify:server` checks local
process startup, restart, disposal, and Windows descendant shutdown.
`verify:context` runs the installed OpenCode against a local deterministic model.
It checks exact persisted human messages, model-facing context and replay,
synthetic continuations, auxiliary requests, and native overflow compaction.
Its temporary workspace and runtime data are isolated inside the repository.
`verify:agent` requires a working OpenCode install and free model. It builds an
eight-section HTML/CSS/JS page in an isolated temporary directory, then reads
and edits it in the same provider session.
`verify:bridge` loads the bundled companion in a real OpenCode server, then
asks a free model to invoke a DSH fixture tool that writes a temporary marker.
It verifies live agent identity, exactly one dispatch, canonical tool history,
completion, and token usage. It was verified with OpenCode v2.0.22.
Live checks depend on free-model availability: one run completed successfully;
a repeat executed the DSH tool successfully but reached its turn deadline
before the final response. Cleanup warnings preserve the original test error.

## License

MIT
