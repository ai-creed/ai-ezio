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
| Distribution    | Single artifact — hax binary embedded in the ezio bundle         | Users install one thing; never manage hax separately. |
| Targets         | macOS + Linux                                                    | hax is Unix-first; extra-fd inheritance is clean on Unix. |
| Visibility      | Private                                                          | Pre-implementation. |

Open (decided later): final packaging form (Node SEA vs `bun build --compile`
vs npm prebuilt per-platform binaries) — decided at Milestone 1.

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
│  packages/adapter                    │        │                                  │
│    ai-whisper handoff / handback     │        │  everything else = upstream hax  │
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

Downstream change surface (kept minimal — see `UPSTREAM.md`):

- `src/protocol/emit.c` (+ header) — translate `stream_event` → JSONL, write fd.
- `--protocol-fd=<n>` / `--control-fd=<n>` CLI flags.
- ~2-3 lines registering the callback + parsing flags; one `meson.build` line.

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

### `packages/adapter`
ai-whisper glue. Spawns ai-ezio in mounted mode and uses the harness/protocol
for handoff delivery and response capture — no clipboard as the primary
handback path. Implements whatever ai-whisper's shared `AgentType` contract
requires.
Depends on: `harness`.

### `packages/cli`
The `ai-ezio` user-facing binary. Interactive REPL passthrough for humans,
`--mount-mode` for machines, plus structured status/diagnostics (`--version
--json` with ezio version + hax base commit, `doctor`, `skill list`/`skill
dirs`, interactive `/skills`).
Depends on: `harness`.

## Data flow (mounted turn)

```text
ai-whisper ──► adapter.submit(text)
                  └► harness.send({type:"submit", text})  ──fd4──►  hax reads control
hax runs the turn, emit.c streams events ──fd3──►  protocol.decode  ──►  harness
  ready / user_turn_started / assistant_turn_started / assistant_delta*
  / tool_call_started / tool_call_finished / assistant_turn_finished / idle
harness surfaces assistant_turn_finished.content as the handback text  ──► adapter ──► ai-whisper
```

The rule restated: ai-whisper must never infer readiness or response text from
terminal chrome when ai-ezio can report it explicitly over the protocol.

## Distribution model

One installable artifact. Build pipeline: compile the patched hax for each
target, embed the binary as an asset inside the ezio bundle, ship one install.
The harness locates and spawns the embedded binary; users never see or install
hax. Final packaging form is chosen at Milestone 1.

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
