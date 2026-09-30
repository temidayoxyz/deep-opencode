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

Requires the OpenCode CLI on your `PATH` (`opencode --version`).

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
| `host` | `127.0.0.1` | Loopback host the managed server binds. |
| `port` | `0` | Port for the managed server; `0` lets the OS choose a free one. |
| `startupTimeoutMs` | `120000` | Deadline for the server to report its listening URL. |
| `turnTimeoutMs` | `900000` | Bound on one delegated turn; `0` disables it. |
| `logDiagnostics` | `true` | Report the managed server's version and discovered models on load. |

```yaml
- name: dsh-deep-opencode
  config:
    opencodeCommand: opencode
    turnTimeoutMs: 1200000
```

## Model Experience

### Delegated model requests

#### What the model sees

Each dsh turn is flattened into one instruction: the system prompt, then each
prior user and assistant message labelled `User:` / `Assistant:`, then a closing
line naming the available capabilities. The text is what this plugin sends to
OpenCode; OpenCode then applies its own agent behaviour on top of it.

#### Token effect

This plugin adds no input tokens of its own. The label prefixes and the
capability line are part of the delegated instruction, and the provider's own
counting is reported unchanged in `usage`.

#### KV Cache effect

Independent per turn. The delegated instruction is rebuilt for every request from
the current message history, so this plugin preserves no reusable request prefix
and does not invalidate one it did not create.

## Known Limitations and Deferred Work

- **OpenCode owns the turn, not the harness.** The delegated run uses OpenCode's
  own agent and its own tools, so a dsh tool is not what runs on a turn driven
  by this route. The harness still owns the session log, the transcript, and the
  turn lifecycle.
- **Conversation history is flattened per turn.** Prior turns are sent as
  labelled text rather than replayed as structured history, because OpenCode runs
  a fresh session per request and never saw the earlier exchanges.
- **Only the free models are offered.** A paid OpenCode model is reachable
  through the harness's own `opencode`/`opencode-go` providers with a key; this
  route deliberately lists only zero-cost models, because a paid model reached
  through a free route would be a real charge.
- **A model the installed OpenCode does not serve cannot be used here**, even if
  a catalogue lists it as free. Availability is whatever the running server
  reports, which is why the list is discovered rather than hard-coded.
- **No reasoning-effort selection.** OpenCode chooses its own reasoning settings;
  this route does not expose the provider's effort levels.
- **Image inputs are not forwarded.** Only text reaches the delegated turn, so a
  model that accepts images is still driven with text here.
- **A missing or broken OpenCode install fails at request time**, not at mount: the
  route stays registered so a repaired install works without reloading the
  profile. Load-time discovery failure is logged as a warning.
- **One managed server per Host.** Reloading the plugin terminates and relaunches
  it, which drops in-flight delegated turns.

## License

MIT
