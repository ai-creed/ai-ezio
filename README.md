# ai-ezio

A hax-derived, workflow-native coding agent — and a **generic MCP host** — for
the ai-creed / ai-whisper ecosystem.

ai-ezio keeps hax's strengths (a fast, small terminal coding assistant) and adds
two things on top: an explicit **machine protocol** so automated callers never
have to scrape a TUI, and a built-in **MCP host** so the agent can talk to any
ecosystem service (ai-cortex first). It is a good terminal app for humans and a
controllable engine for ai-creed / ai-whisper at the same time.

```text
hax      = minimal standalone coding assistant (C)
ai-ezio  = hax-derived workflow-native coding agent + MCP host
           (C engine + TypeScript harness)
```

> **Status:** public beta, published to npm as `ai-ezio` (re-exporting
> `@ai-creed/ai-ezio`). See [`docs/milestones.md`](./docs/milestones.md) for the
> build plan and [`docs/architecture.md`](./docs/architecture.md) for the design.

---

## Contents

- [What it is](#what-it-is)
- [Install](#install)
- [Connect it to a model (required)](#connect-it-to-a-model-required)
- [First run & the setup wizard](#first-run--the-setup-wizard)
- [Using it](#using-it)
- [Configuring MCP servers](#configuring-mcp-servers)
- [Optional configuration](#optional-configuration)
- [Architecture](#architecture)
- [Build from source](#build-from-source)
- [Lineage & attribution](#lineage--attribution)
- [License](#license)

---

## What it is

ai-ezio is a **hybrid**:

- a **C engine** — [hax](https://github.com/OleksandrChekhovskyi/hax), vendored
  as a git submodule under `vendor/hax`. This is the streaming / provider / tool
  core. It runs **headless**: spawned with no terminal of its own, speaking only
  an explicit JSONL protocol.
- a **TypeScript harness** — everything in `packages/`. It owns the terminal,
  renders the conversation, hosts MCP servers, manages sessions and context
  compaction, and ships the `ai-ezio` binary.

The engine does the model round-trips and tool execution; the harness owns
everything a human (or an automated workflow) sees and drives. The two talk over
inherited file descriptors, never over scraped stdout.

## Install

```sh
npm i -g ai-ezio
```

The `ai-ezio` package pulls in the matching prebuilt hax engine as a
per-platform `@ai-creed/hax-<os>-<cpu>` optional dependency, so the right binary
is fetched for your host at install time — **you never install or manage hax
separately.**

- **Supported platforms:** macOS arm64, macOS x64, Linux x64, Linux arm64.
- **Requires:** Node ≥ 20.
- **Verify the install:** `ai-ezio doctor` (reports the engine binary, skill
  directories, and setup state).

> Building from a git checkout instead of npm? See
> [Build from source](#build-from-source).

## Connect it to a model (required)

A fresh install talks to nothing until you point the underlying hax engine at a
model provider. The simplest way is a couple of **environment variables**, and
they take precedence over every other config source — so a quick
`HAX_PROVIDER=… HAX_MODEL=… ai-ezio` always works. (The engine also reads an
optional `~/.config/hax/config.json` for persisted settings, but environment
variables override it.)

Two things to know up front:

1. There is **no native Anthropic provider.** hax speaks to OpenAI-family and
   local backends: `codex`, `openai`, `openai-compatible`, `openrouter`,
   `ollama`, `llama.cpp` (plus `mock` for testing). You can still reach Claude
   models — just route through **OpenRouter** (see below).
2. The two knobs that matter are `HAX_PROVIDER` (which backend) and `HAX_MODEL`
   (which model), plus the provider's API key.

### Primary: Codex (reuse an existing ChatGPT / Codex login)

`codex` is the default provider, so if you already use OpenAI's official `codex`
CLI there is almost nothing to configure — ezio reuses the OAuth token it stores
in `~/.codex/auth.json`, and auto-detects the model (defaulting to
`gpt-5.3-codex`).

```sh
codex      # log in once if you haven't — creates ~/.codex/auth.json
ai-ezio    # reuses that login (HAX_PROVIDER defaults to codex)
```

If the token has expired, run `codex` once to refresh it, then re-run `ai-ezio`.

### Secondary: OpenAI (bring your own key)

```sh
export HAX_PROVIDER=openai
export OPENAI_API_KEY=sk-...     # or HAX_OPENAI_API_KEY (preferred)
export HAX_MODEL=gpt-5.5
ai-ezio
```

### Other providers

- **OpenRouter** — one key, any model, including Claude:

  ```sh
  export HAX_PROVIDER=openrouter
  export OPENROUTER_API_KEY=sk-or-...     # or HAX_OPENAI_API_KEY
  export HAX_MODEL=anthropic/claude-sonnet-4.6
  ai-ezio
  ```

- **Local, no API key** — `ollama` (requires `HAX_MODEL`) or `llama.cpp`
  (auto-detects the loaded model):

  ```sh
  export HAX_PROVIDER=ollama
  export HAX_MODEL=qwen3:8b
  ai-ezio
  ```

- **OpenAI-compatible** (vLLM, LM Studio, custom proxies) — set
  `HAX_PROVIDER=openai-compatible` and `HAX_OPENAI_BASE_URL`.

### Engine environment variables

The most relevant `HAX_*` variables. Each also maps to a key in the optional
`~/.config/hax/config.json`, but env vars take precedence — so the variables
below are all you need.

| Variable             | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `HAX_PROVIDER`       | Backend: `codex` (default), `openai`, `openai-compatible`, `openrouter`, `ollama`, `llama.cpp`, `mock`. |
| `HAX_MODEL`          | Model id. Required for most providers; auto-detected for `codex` and `llama.cpp`. |
| `HAX_OPENAI_API_KEY` | Preferred Bearer token for every OpenAI-family provider. Falls back to `OPENAI_API_KEY` (openai) / `OPENROUTER_API_KEY` (openrouter). |
| `HAX_OPENAI_BASE_URL`| Required for `openai-compatible`; overrides the URL for `ollama` / `llama.cpp`. |
| `HAX_REASONING_EFFORT` | `minimal` / `low` / `medium` / `high` / `xhigh` (passed verbatim to the provider). |
| `HAX_CONTEXT_LIMIT`  | Manual context-window override for the usage display. |
| `HAX_TRACE` / `HAX_TRANSCRIPT` | Debug: wire-level HTTP/SSE dump / model-perspective transcript mirror. |
| `HAX_NO_SESSION`     | Disable session recording. |

For the complete list (runtime timeouts, per-provider ports, attribution
headers, …), see hax's own
[README](https://github.com/OleksandrChekhovskyi/hax#environment-variables).

## First run & the setup wizard

Run `ai-ezio` with no arguments to launch the interactive REPL. The **first**
time you do, a short setup wizard runs automatically (you can re-run it any time
with `ai-ezio init`). It is best-effort — it never blocks you from entering the
REPL — and offers to:

- install and wire **ai-cortex** (the ecosystem memory layer) into your
  `mcp.json`;
- persist an `AI_EZIO_HAX_BIN` bridge into your shell profile, so sibling tools
  (ai-whisper, ai-14all) can find the embedded hax engine.

> The wizard does **not** configure your model provider — that's the
> environment-variable step [above](#connect-it-to-a-model-required), which is
> the one piece of setup ezio can't do for you.

Check what's wired up, and re-run setup, at any time:

```sh
ai-ezio doctor                 # engine binary, skills, and setup state
ai-ezio init --reconfigure     # re-run the wizard
```

## Using it

| Command                      | What it does                                              |
| ---------------------------- | -------------------------------------------------------- |
| `ai-ezio`                    | Interactive REPL (ezio owns the terminal; full unified stack). |
| `ai-ezio -p "<prompt>"`      | One-shot: run the prompt to completion and print the final answer. |
| `ai-ezio -c`                 | Resume the most recent session in this directory.        |
| `ai-ezio --resume`           | Pick a past session from a list. `--resume=<id>` resumes one directly. |
| `ai-ezio doctor`             | Diagnostics: engine, skills, and wired state.            |
| `ai-ezio init [--reconfigure]` | (Re-)run the first-run setup wizard.                   |
| `ai-ezio skill list` / `skill dirs` | List discovered skills / the directories they load from. |

The interactive, one-shot, and resume paths all run the **unified stack**: the
MCP host, context compaction, and ezio's rendering are active, with hax headless
underneath. Sessions are recorded per working directory, so `-c` / `--resume`
only ever offer conversations from the project you're in.

**Mounted mode** (`ai-ezio --mount-mode`, or inheriting `--protocol-fd` /
`--control-fd`) is the machine-driven path used by ai-whisper and ai-14all: hax
stays headless and the caller renders the protocol stream itself. No terminal
chrome is involved.

## Configuring MCP servers

ezio is a **generic MCP host**. Register servers in
`${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/mcp.json`. The format is the familiar
`mcpServers` map, plus two ezio-specific keys:

```json
{
  "mcpServers": {
    "cortex": { "command": "ai-cortex", "args": ["mcp"] }
  },
  "toolPolicy": {
    "cortex__purge_memory": "deny",
    "cortex__trash_memory": "deny",
    "cortex__promote_to_global": "deny"
  },
  "hostPrivateTools": ["cortex__capture_session"]
}
```

- **`mcpServers`** — each entry is `{ command, args, env? }`, spawned over stdio.
- **`toolPolicy`** — per-tool permission keyed by the namespaced tool name:
  `"allow"`, `"deny"`, or `"confirm"` (prompt the human). In mounted mode, where
  there's no human to ask, `"confirm"` is treated as `"deny"`.
- **`hostPrivateTools`** — tools hidden from the model but still callable by the
  harness itself.

Tools are namespaced `<server>__<tool>` to avoid collisions across servers. A
few destructive ai-cortex tools (`purge_memory`, `trash_memory`,
`promote_to_global`) are denied by default, and `cortex__capture_session` is
host-private by default, even if you don't list them.

A ready-to-copy starting point lives at
[`docs/mcp.example.json`](./docs/mcp.example.json).

## Optional configuration

General ezio settings (today: context-compaction tuning) live in
`${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/config.json`, a sibling of `mcp.json`.
The file is optional; a missing file or section uses the defaults shown:

```json
{
  "compaction": {
    "auto": true,
    "threshold": 0.8,
    "keepLastTurns": 2,
    "rehydrate": true
  }
}
```

- **`auto`** — automatically compact the context as it fills (default `true`).
  `/compact` always works manually regardless of this setting.
- **`threshold`** — fullness ratio that arms auto-compaction (`0.3`–`0.95`).
- **`keepLastTurns`** — verbatim tail kept by a compaction (`0`–`10`).
- **`rehydrate`** — re-enrich context from ai-cortex after compacting.

Out-of-range values are clamped, with a note surfaced by `ai-ezio doctor`.

## Architecture

```text
ai-ezio (TypeScript monorepo, pnpm)        vendor/hax (C submodule + emitter patch)
  packages/protocol         JSONL schema      src/protocol/emit.c  hooks turn on_event()
  packages/harness          spawn + lifecycle  --protocol-fd / --control-fd flags
  packages/mcp-host         generic MCP host   (small, isolated, rebaseable patch)
  packages/subagent         subagent host (child hax sessions)
  packages/session-hosts    session host stack (delegated-tool registry)
  packages/surface          REPL rendering
  packages/session-recorder transcript capture
  packages/cli              `ai-ezio` binary
```

The dividing rule: **engine work is C and lives in hax; product work is TS and
lives in `packages/`.** The protocol is the contract — readiness and response
text come from explicit JSONL events, never from parsing terminal output.
Transport uses inherited file descriptors (events on fd 3, controls on fd 4);
stdout/stderr stay human-only, behind a seam so a Unix socket or stdio framing
can be added later without touching protocol logic.

Full design: [`docs/architecture.md`](./docs/architecture.md),
[`docs/protocol.md`](./docs/protocol.md). The hax fork and our vendoring policy
are documented in [`UPSTREAM.md`](./UPSTREAM.md).

## Build from source

For working on ezio itself (npm users don't need any of this):

```sh
# System dependencies for the hax engine
#   macOS:  brew install jansson meson ninja pkg-config   (libcurl ships with macOS)
#   Debian: sudo apt install libcurl4-openssl-dev libjansson-dev meson ninja-build pkg-config

pnpm install                                              # TS deps (pnpm ≥ 9, Node ≥ 20)
git submodule update --init                               # fetch vendor/hax at the pinned commit
meson setup vendor/hax/build                              # configure the C build (once)
meson compile -C vendor/hax/build                         # build the hax engine
pnpm -r build                                             # build the TS packages
```

Run the tests:

```sh
pnpm -r test                       # TS packages
meson test -C vendor/hax/build     # hax engine
```

When running from a checkout, point ezio at your locally-built engine with
`AI_EZIO_HAX_BIN=vendor/hax/build/hax` (this override takes precedence over the
prebuilt platform package). Anything under `vendor/hax` follows hax's own style
and `AGENTS.md`, not this repo's TypeScript conventions — read
[`UPSTREAM.md`](./UPSTREAM.md) before touching it.

## Lineage & attribution

ai-ezio is derived from **hax**, a minimalist terminal coding assistant in C,
originally authored by **Oleksandr Chekhovskyi**
(<https://github.com/OleksandrChekhovskyi/hax>). ai-ezio retains hax's core
provider / tool / streaming architecture and adds the ai-creed protocol, MCP
host, and harness on top. hax is vendored as a git submodule under `vendor/hax`;
the only downstream change to the engine is a small, isolated protocol emitter,
kept minimal so the fork can keep syncing with upstream. See
[`UPSTREAM.md`](./UPSTREAM.md) and [`NOTICE`](./NOTICE).

## License

MIT. ai-ezio carries hax's MIT license and Oleksandr Chekhovskyi's copyright
forward. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
