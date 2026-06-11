# ai-ezio architecture

> Canonical design. If a decision here changes, update this file and the spec in
> `docs/superpowers/specs/`.

## Intent

ai-ezio is a hax-derived coding agent for the ai-creed / ai-whisper ecosystem.
It preserves hax's strengths (fast, small terminal coding assistant) and adds
the workflow-native behavior needed for mounted, machine-controlled
collaboration — without growing hax itself into a larger product.

Guiding principle: **do not pretend automation is a human typing into a TUI.**
Keep a good terminal UI for humans, but expose an explicit machine protocol for
ai-creed and ai-whisper.

## Decisions (locked at kickoff)

| Decision        | Choice                                                            | Why |
| --------------- | ---------------------------------------------------------------- | --- |
| Architecture    | Thin C emitter in hax + TypeScript harness                       | Keep hax's engine; put product in TS where the ecosystem (ai-whisper) lives. No scraping. |
| Language split  | Engine = C (hax). Harness = TypeScript.                          | C is right for fast IO/stream in the engine; the harness doesn't need it and benefits from sharing ai-whisper's TS toolchain. |
| Repo layout     | Monorepo `ai-ezio` + hax as git submodule (`vendor/hax`)         | One clone, one build pipeline, simplest path to a single bundled artifact. |
| Transport       | Inherited file descriptors (fd 3 events, fd 4 controls)          | Bundled app owns its child; no socket path/port/cleanup; child dies with parent. |
| Transport seam  | Pluggable — socket / stdio framing addable later                 | Wire format (JSONL) is identical across transports; not a lock-in. |
| Distribution    | Single install — hax binary embedded in the ezio bundle          | Users install one thing; never manage hax separately. |
| Packaging form  | npm package + prebuilt per-platform hax binary (esbuild/swc-style) | Serves both consumers (standalone CLI + ai-whisper import) from one artifact; matches Node/pnpm. |
| Runtime         | Node LTS                                                         | Matches ai-whisper (pnpm, node-pty native module); no second toolchain. |
| Targets         | macOS + Linux (arm64 + x64)                                      | hax is Unix-first; extra-fd inheritance is clean on Unix. |
| Visibility      | Private                                                          | Pre-implementation. |

ai-ezio is consumed two ways, which is why a compiled single-file (Node SEA /
`bun build --compile`) was rejected: it serves the CLI but cannot be `import`ed
as a library by ai-whisper, forcing a second artifact. The npm-package model
serves both from one.

- **Standalone CLI** — `npm i -g ai-ezio`; end user runs `ai-ezio`.
- **Library** — ai-whisper imports the adapter (like `adapter-codex` today,
  which spawns its agent by executable path — the same pattern ai-ezio uses).

## The hybrid

```text
┌─────────────────────────────────────┐        ┌──────────────────────────────────┐
│ ai-ezio  (TypeScript, pnpm monorepo) │        │ vendor/hax  (C submodule)         │
│                                      │        │                                  │
│  packages/cli                        │ spawn  │  hax binary                      │
│    `ai-ezio` entrypoint  ───────────────────► │   --protocol-fd=3 --control-fd=4 │
│  packages/harness                    │        │                                  │
│    spawn + session/turn lifecycle    │◄──fd3──┤  src/protocol/emit.c             │
│    owns the child, exposes protocol  │ events │    hooks turn on_event()         │
│  packages/protocol                   │──fd4──►│    reads controls                │
│    JSONL schema + codec + transport  │ ctrls  │  (the only downstream patch)     │
│  (adapter-ai-ezio lives in ai-whisper│        │                                  │
│   — workflow glue, imports harness)  │        │  everything else = upstream hax  │
└─────────────────────────────────────┘        └──────────────────────────────────┘
              stdout / stderr stay human-only (terminal UI untouched)
```

### Why a C patch is unavoidable (and why it's tiny)

A pure-TS wrapper around an unmodified hax binary could only read hax's
stdout/stderr — which is exactly the TUI-scraping anti-pattern this project
exists to kill. Clean machine control requires hax to emit *structured* events.

But the patch is small because hax already has the right seam: `src/turn.c`
exposes an `on_event(struct stream_event *)` callback that already sees text
deltas, tool-call start/end, reasoning, done, and error events. The emitter
hooks that callback and writes JSONL to a file descriptor. hax already links
**jansson**, so JSON encoding adds no dependency.

But the lifecycle events the protocol needs (engine ready, a user turn accepted,
a turn finished with its authoritative final text, engine idle) have **no**
public seam in hax today — only per-stream events do. So the change has two
parts: a small **upstreamable seam** plus a **downstream emitter** (full
rationale in `docs/superpowers/specs/2026-06-03-m3-protocol-mvp-design.md`).

Downstream change surface (kept minimal — see `UPSTREAM.md`):

- **Upstreamable:** `src/agent_observer.h` — a general `struct agent_observer` of
  optional agent-loop lifecycle hooks (mirrors `struct provider`/`struct tool`),
  invoked at ~5 points in `agent_run`; plus `--protocol-fd` / `--control-fd`.
- **Downstream:** `src/protocol/emit.c` (+ header) implementing the observer +
  translating `stream_event` → JSONL on the fd + reading controls; one
  `on_event` hook, the input-source swap, the tick control-read, one
  `meson.build` line.

## Components (TypeScript harness)

Each package has one clear purpose and a well-defined interface.

### `packages/protocol`
The wire contract. JSONL message schema (events + controls), an encode/decode
codec, and a **transport interface** (`read(): AsyncIterable<Event>`,
`send(control): void`). The fd transport is the first implementation; the
interface keeps socket/stdio addable without touching anyone else.
Depends on: nothing (leaf).

### `packages/harness`
Owns the hax child process and the session/turn lifecycle. Spawns hax with the
event/control fds wired, translates protocol events into a typed session API
(ready, turn started/finished, idle, error, last-response), and forwards
controls (submit, interrupt, copy_last_response, new_conversation, status).
This is where "readiness, turn boundaries, and handback text" become explicit.
Depends on: `protocol`.

### ~~`packages/adapter`~~ — retired (lives in ai-whisper as of M5)
The ai-whisper adapter is **workflow-serving glue**, so per the M5 decision it
lives in the ai-whisper repo as `packages/adapter-ai-ezio` (importing
`@ai-ezio/harness`), **not** in ai-ezio. ai-ezio's own `packages/adapter`
placeholder is retired. The rule: `@ai-ezio/harness` stays workflow-agnostic so
ai-ezio runs standalone (a Codex drop-in); anything that exists only to serve an
ai-whisper workflow lives in ai-whisper. See
`docs/superpowers/specs/2026-06-04-m5-adapter-design.md`.

### `packages/cli`
The `ai-ezio` user-facing binary. A bare interactive `ezio` **self-mounts** (see
"Terminal ownership"), `--mount-mode` for machines, plus structured
status/diagnostics (`--version --json` with ezio version + hax base commit,
`doctor`, `skill list`/`skill dirs`, interactive `/skills`).
Depends on: `harness`, `mcp-host`, `surface`.

### `packages/mcp-host` (M9)
The generic **MCP host** — where all MCP/ecosystem intelligence lives. Spawns and
connects stdio MCP servers (`@modelcontextprotocol/sdk`), lists their tools,
registers them with hax as **delegated tools** (`<server>__<tool>` namespacing),
and services each `tool_call_requested` by routing to the owning server and
replying with a `tool_result`. Owns cwd injection (schema-aware, drift-proof),
the config-driven `allow|deny|confirm` policy, per-call timeouts, and server
lifecycle. hax knows nothing about MCP — only "this tool's result comes from the
host." The shared `loadMcpHost` factory is wired by **both** Session creators (the
standalone CLI and ai-whisper's mounted adapter).
Depends on: `harness`, `protocol`.

## Terminal ownership (unified, M9)

hax is **always headless**: spawned with stdin/stdout/stderr ignored, it speaks
only the protocol (events on fd 3, controls on fd 4) and never reads the keyboard
or paints the screen. ezio (TS) **always owns the terminal** in both run modes:

- **Output** — the M7/M8 `surface` renders the protocol stream (banner, markdown,
  tool calls, usage, prompt).
- **Input** — in **standalone** a small **line-buffered reader** owns the keyboard
  and feeds `submit`; in **mounted** the host app (ai-whisper / 14all) provides the
  input box and hands ezio a finished prompt string.
- **MCP host** — sits in this same loop, servicing delegated tool calls.

"Headless" means terminal-less and persistent/interactive (`--mount-mode`), **not**
one-shot — the session stays alive across turns and keeps conversation context.

### Transcript view (Ctrl+T parity)

ezio's standalone REPL reproduces hax's interactive Ctrl+T transcript view without
owning the engine's TTY. Because hax is headless, its own raw-mode Ctrl+T binding
is unreachable; instead the harness sets `HAX_TRANSCRIPT` at spawn to a
caller-minted, pre-spawn path (`<ezioStateDir>/transcripts/<repoKey>/<uuid>.txt`)
and re-exposes it as `Session.transcriptPath`. hax mirrors its live
model-perspective transcript there — system prompt, advertised tools, and every
item (user / assistant / tool-call args / tool-result / reasoning / turn
boundaries), plain text, no ANSI. Ctrl+T (intercepted in the line reader) and the
`/transcript` slash command page that file via `$PAGER` (falling back to an inline
dump when there is no TTY or pager).

- **No hax C change.** The mirror is a pure env opt-in; hax owns the rendering, so
  ezio never re-implements the view (Option B1 of the design spec).
- **Pre-spawn filename.** The id is minted before spawn because hax opens the
  mirror (`agent.c` `transcript_log_open`) *before* it emits `ready`, so the
  protocol `ready.sessionId` is not available in time.
- **Lifecycle fidelity (verified against `vendor/hax`).** `/new` truncates the
  mirror (`transcript_log_reset`); `--continue`/`--resume` rebuild it with the
  replayed history (`agent.c` reset + `transcript_log_append(items, n_items)`); and
  `/compact` resets **and re-seeds** it with the full post-compact history
  (`agent_compact` → `transcript_log_reset` + `flush_logs`), so the file reflects
  the compacted state rather than retaining a stale tail.

The same `Session.transcriptPath` seam lets ai-whisper's mounted mode add its own
Ctrl+T binding (a downstream follow-up); the harness is the single source for the
path in both run modes.

## Data flow (mounted turn)

```text
ai-whisper adapter-ai-ezio ──► harness session.submit(text)
                  └► harness.send({type:"submit", text})  ──fd4──►  hax reads control
hax runs the turn, emit.c streams events ──fd3──►  protocol.decode  ──►  harness
  ready / user_turn_started / assistant_turn_started / assistant_delta*
  / tool_call_started / tool_call_finished / assistant_turn_finished / idle
harness surfaces assistant_turn_finished.content as the handback text  ──► adapter-ai-ezio ──► ai-whisper
```

(The `adapter-ai-ezio` package lives in the ai-whisper repo; ai-ezio ships only
`protocol` + `harness` + `cli`.)

The rule restated: ai-whisper must never infer readiness or response text from
terminal chrome when ai-ezio can report it explicitly over the protocol.

## Distribution model

One install. Packaging follows the esbuild/swc pattern: a main `ai-ezio` package
(JS launcher + harness + protocol) declares per-platform binary packages as
`optionalDependencies`, each gated by `os`/`cpu` so npm installs only the match.

```text
ai-ezio                         main pkg; `bin` = JS launcher that resolves + spawns hax
  optionalDependencies:
    @ai-ezio/hax-darwin-arm64   } one compiled hax binary per os/cpu,
    @ai-ezio/hax-darwin-x64     } "os"/"cpu" fields restrict install to the
    @ai-ezio/hax-linux-x64      } matching platform
    @ai-ezio/hax-linux-arm64    }
```

`npm i -g ai-ezio` pulls the one matching binary package; users never see or
install hax. The same package is `import`-able by ai-whisper.

### Binary lookup resolver

The harness resolves the hax binary path in this order:

1. `AI_EZIO_HAX_BIN` env override (dev / CI / tests);
2. matching `@ai-ezio/hax-<platform>` package via `require.resolve`;
3. local `vendor/hax/build/hax` (dev fallback after `meson compile`).

If none resolve, fail with a clear message pointing at `ai-ezio doctor`.

### Build pipeline

`meson compile -C vendor/hax/build` produces the binary; a publish step copies
each target's binary into its platform package. **Cross-compiling hax C for each
target is the one genuinely involved piece** and needs a CI build matrix
(darwin-arm64/x64, linux-x64/arm64). For local development the resolver's
dev fallback (#3) is sufficient — the publish matrix can be finished last.

## What stays in hax vs ai-ezio

- **hax (upstream-eligible):** provider abstraction, streaming, tools, terminal
  UI, sessions/transcripts, skill discovery, mock/debug provider, and the
  generic protocol emitter (proposed back upstream).
- **ai-ezio (downstream-only):** protocol semantics/versioning, mount mode,
  ai-whisper adapter, skills UX product surface, single-artifact packaging.

## Risks / watch-items

- **Upstream churn on the event model** — the one place a major hax change could
  force a real (but localized) port of `emit.c`. Mitigated by keeping the patch
  on the stable `on_event` seam and upstreaming it.
- **fd inheritance** — Unix-only by design; revisit transport seam if Windows is
  ever required (switch to stdio framing; same JSONL schema).
- **Skills parity** — how skills are shared across Claude, Codex, hax, and
  ai-ezio is an open study item (see milestones M2).
