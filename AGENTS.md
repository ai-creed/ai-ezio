# AGENTS.md

Guidance for AI agents (and humans) working in the ai-ezio repository.

## What this project is

ai-ezio is a **hax-derived, workflow-native coding agent**. It is a **hybrid**:

- a **C engine** — hax, vendored unchanged-except-for-one-patch as a git
  submodule under `vendor/hax`. This is the streaming / provider / tool core.
  **Do not reimplement it in TypeScript.**
- a **TypeScript harness** — everything in `packages/`. The protocol client,
  mount mode, generic MCP host, mounted-REPL surface, session recorder, skills
  UX, and the `ai-ezio` CLI. (The ai-whisper adapter is **not** here — it was
  retired at M5 and lives downstream in the ai-whisper repo.)

The dividing rule: **engine work is C and lives in hax; product work is TS and
lives in `packages/`.** When in doubt, push behavior into the TS harness; keep
the hax patch as small as possible (see `UPSTREAM.md`).

## Repository structure

```text
ai-ezio/
  README.md            intro + lineage
  NOTICE               attribution (hax / Oleksandr Chekhovskyi)
  LICENSE              MIT (carried from hax)
  UPSTREAM.md          how hax is vendored + sync/merge policy  <- read before touching vendor/hax
  AGENTS.md            this file
  docs/
    architecture.md    the hybrid design (read this first)
    protocol.md        JSONL event/control schema + fd transport
    milestones.md      build plan (M1..M11)
    superpowers/specs/ canonical design specs
  vendor/hax/          C engine (git submodule; emitter patch on `emitter` branch)
  packages/            TypeScript harness
    protocol/          JSONL schema + codec + transport seam
    harness/           spawn hax, own session/turn lifecycle, compaction, expose protocol
    mcp-host/          generic stdio MCP host (spawn/connect servers, policy, namespacing)
    surface/           mounted-REPL rendering (banner, markdown, tool calls, usage)
    session-recorder/  transcript capture
    cli/               `ai-ezio` binary
```

> The ai-whisper adapter is **not** a package here. It was retired at M5 and now
> lives in the ai-whisper repo as `packages/adapter-ai-ezio` (it imports
> `@ai-ezio/harness`). Workflow glue lives downstream; the harness stays
> workflow-agnostic.

> Current state: shipped and published. `packages/` and the `vendor/hax`
> submodule are fully wired; ai-ezio is on npm as `ai-ezio` /
> `@ai-creed/ai-ezio` (`0.2.0-beta.2`), built through M11 (context compaction;
> generic MCP host + unified terminal at M9) — see `docs/milestones.md`.

## Working agreements for agents

1. **Read first:** `docs/architecture.md`, then `docs/protocol.md`, then this
   file. For any change under `vendor/hax`, read `UPSTREAM.md` first.
2. **Respect the engine/harness boundary.** New product behavior goes in
   `packages/`. The sanctioned hax-extension areas are the **protocol emitter**
   and the **host-delegated tools** seam (M9) — both MCP-agnostic and generic.
   All MCP/config/policy intelligence lives in `packages/mcp-host` (TS), never in
   hax: the engine only knows "this tool's result comes from the host."
3. **Keep the hax fork minimal & rebaseable.** We maintain our own hax fork (we do
   not upstream), so every C change must stay localized so the fork can keep
   syncing with upstream hax. If a change to hax grows beyond a tiny generic seam,
   stop and reconsider — it probably belongs in the harness.
4. **Protocol is the contract.** Do not infer readiness or response text from
   terminal chrome. Emit/consume explicit JSONL events. Any new event or control
   must be documented in `docs/protocol.md` first.
5. **No scraping.** The whole point of ai-ezio is to replace TUI scraping with an
   explicit machine protocol. Never reintroduce stdout parsing as a control path.
6. **One installable artifact.** Changes must preserve single-bundle
   distribution (hax binary embedded). Don't add a step that makes users install
   hax separately.
7. **Targets:** macOS + Linux. Transport uses inherited fds; don't assume
   Windows fd semantics.

## Conventions

### TypeScript (`packages/`)

- pnpm workspace, TypeScript, Node LTS. Match ai-whisper's toolchain where it
  makes sense (it is the sibling consumer).
- ESLint + Prettier + `.editorconfig`. Baseline: **tabs** for indentation,
  **double quotes**, **semicolons**, **multiline trailing commas**. Format
  source only; exclude generated output.
- Small, single-purpose modules with well-defined interfaces. Prefer code that
  fits in one file you can reason about at once.

### C (`vendor/hax`)

hax has its own style — **follow hax's `AGENTS.md`, not this file's TS rules**,
for anything under `vendor/hax`. In short: LLVM/Linux-kernel style, **4-space
indent, spaces not tabs**, snake_case, `struct foo` (no typedefs), C11, every
file starts with `/* SPDX-License-Identifier: MIT */`. Run `clang-format -i` on
any C file you touch. Build/test with meson (`meson compile -C vendor/hax/build`,
`meson test -C vendor/hax/build`).

> Note the indentation difference is intentional: TS uses tabs (project
> baseline), vendored C uses 4 spaces (hax's enforced style). Never reformat
> hax sources to the TS style — it would wreck upstream rebases.

## Build, test (planned — wired at Milestone 1)

```sh
pnpm install                      # TS deps
git submodule update --init       # fetch vendor/hax at pinned emitter commit
meson setup vendor/hax/build && meson compile -C vendor/hax/build   # build engine
pnpm -r build                     # build TS packages
pnpm -r test                      # test TS packages
meson test -C vendor/hax/build    # test engine
```

## Useful hax debug hooks (from the engine)

- `HAX_PROVIDER=mock` — scripted provider, no LLM round-trip. Good for testing
  the protocol emitter and harness lifecycle deterministically.
- `HAX_TRACE=path` — wire-level HTTP/SSE dump.
- `HAX_TRANSCRIPT=path` — model-perspective transcript mirror.

## Memory / decisions

Key kickoff decisions (architecture = thin C emitter + TS harness; repo =
monorepo + hax submodule; transport = inherited fds; single bundled artifact;
macOS+Linux) are recorded in `docs/architecture.md` and the design spec under
`docs/superpowers/specs/`. Update those docs when a decision changes.
