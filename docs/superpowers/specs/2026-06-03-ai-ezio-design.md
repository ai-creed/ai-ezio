# ai-ezio — design spec

- **Date:** 2026-06-03
- **Status:** approved (kickoff), pre-implementation
- **Visibility:** private
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/specs/` (this file is the synced mirror)

## Problem

ai-creed / ai-whisper need a fast terminal coding agent that is also cleanly
**machine-controllable** for mounted, automated sessions. Today's mounted-agent
integrations lean on pretending automation is a human typing into a TUI, then
scraping the terminal for readiness and response text. That is fragile.

hax is an excellent minimal terminal coding agent (C), but it has no machine
protocol. We want hax's engine plus an explicit protocol and workflow
integration — without turning hax into a bigger product.

## Goals

- Preserve hax's engine (providers, streaming, tools, REPL) unchanged except for
  one tiny patch.
- Expose an explicit JSONL machine protocol: readiness, turn boundaries, tool
  lifecycle, idle, errors, and authoritative handback text.
- Integrate with ai-whisper as a first-class agent type via an adapter.
- Ship as a single installable artifact for macOS + Linux.
- Keep the human terminal UI intact.

## Non-goals

- Not a TS rewrite of hax's engine.
- Not Windows support (initially).
- Not growing hax upstream into a product; downstream behavior stays downstream.
- No clipboard-based handback as a primary path.

## Decisions

| Decision       | Choice                                                       |
| -------------- | ----------------------------------------------------------- |
| Architecture   | Thin C emitter in hax + TypeScript harness                  |
| Language split | Engine = C (hax); harness = TypeScript                      |
| Repo layout    | Monorepo `ai-ezio` + hax as git submodule (`vendor/hax`)    |
| Transport      | Inherited fds (fd 3 events, fd 4 controls), pluggable seam  |
| Distribution   | Single install; hax binary embedded in the ezio bundle      |
| Packaging form | npm package + prebuilt per-platform hax binary (esbuild/swc-style) |
| Runtime        | Node LTS (matches ai-whisper)                               |
| Targets        | macOS + Linux (arm64 + x64)                                 |
| Visibility     | Private                                                     |

## Architecture (summary)

Hybrid: a C engine (hax, vendored as a submodule with one emitter patch) plus a
TypeScript harness (`packages/`) that spawns and drives it over a JSONL protocol
on inherited fds. stdout/stderr remain human-only.

A pure-TS wrapper around unmodified hax was rejected: it could only scrape
stdout, reintroducing the anti-pattern. A full TS rewrite was rejected: it
discards hax's engine and weakens lineage. The emitter is small because hax
already exposes a stable `turn` `on_event(struct stream_event *)` callback and
already links jansson.

Full detail: `docs/architecture.md`. Protocol detail: `docs/protocol.md`.
Build plan: `docs/milestones.md`. Upstream policy: `UPSTREAM.md`.

## Components

- `packages/protocol` — JSONL schema, codec, transport interface (fd impl first).
- `packages/harness` — owns the hax child + session/turn lifecycle; exposes a
  typed protocol API; forwards controls.
- ai-whisper handoff/handback glue is **not an ai-ezio package** — per the M5
  decision it lives in the ai-whisper repo as `packages/adapter-ai-ezio`
  (imports `@ai-ezio/harness`); ai-ezio's `packages/adapter` placeholder is
  retired so the harness stays workflow-agnostic. See
  `docs/superpowers/specs/2026-06-04-m5-adapter-design.md`.
- `packages/cli` — `ai-ezio` binary: REPL passthrough, `--mount-mode`,
  `--version --json`, `doctor`, skills UX.
- `vendor/hax` — C engine submodule; emitter patch on the `emitter` branch.

## Distribution

One install, npm-package model (esbuild/swc-style): a main `ai-ezio` package
declares per-platform binary packages (`@ai-ezio/hax-<os>-<cpu>`) as
`optionalDependencies`, gated by `os`/`cpu`. `npm i -g ai-ezio` pulls the one
matching hax binary; users never install hax separately. The same package is
`import`-able by ai-whisper, so one artifact serves both the standalone CLI and
the ai-whisper adapter. Compiled single-file approaches (Node SEA, `bun
--compile`) were rejected: they can't be imported as a library, forcing a second
artifact. Runtime is Node LTS (matches ai-whisper). Harness resolves the binary
via `AI_EZIO_HAX_BIN` → platform package → `vendor/hax/build/hax` (dev). The one
involved piece is a CI matrix cross-compiling hax C per target. Full detail in
`docs/architecture.md`.

## Downstream change surface in hax (keep tiny)

- `src/protocol/emit.c` (+ header) hooking `on_event`.
- `--protocol-fd` / `--control-fd` flags.
- ~2-3 registration/flag lines + one `meson.build` line.
- Target: propose the emitter upstream so the patch eventually disappears.

## Lineage & license

Derived from hax (MIT, © 2026 Oleksandr Chekhovskyi,
github.com/OleksandrChekhovskyi/hax, base commit
`8fd139b5db49bd0b1d552c2530a18b547b3f4f4c`). MIT carried forward; attribution in
NOTICE, README, and per-file SPDX headers in vendored C.

## Risks

- Major upstream redesign of the event model → localized port of `emit.c`.
- fd inheritance is Unix-only → transport seam allows a stdio-framing fallback.
- Skills sharing across Claude/Codex/hax/ai-ezio is unresolved (M2 study).

## Milestones

M1 foundation · M2 skills discoverability · M3 protocol MVP (incl. C emitter) ·
M4 mounted mode · M5 ai-whisper adapter · M6 workflow integration. See
`docs/milestones.md`.

## Open questions

- `assistant_delta` streaming opt-in; need for `tool_call_delta`.
- Status event payload shape.
- >2 mounted agents in ai-whisper vs ai-ezio as a replacement role.
- Skills sharing model.
- Which generic improvements to upstream.
