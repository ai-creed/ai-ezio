# ai-ezio

A hax-derived, workflow-native coding agent for the ai-creed / ai-whisper
ecosystem.

ai-ezio preserves hax's strengths — a fast, small terminal coding assistant —
while adding the machine-controllable behavior needed for mounted, automated
collaboration. It keeps a good terminal UI for humans, but exposes an explicit
machine protocol so ai-creed and ai-whisper never have to scrape a TUI.

```text
hax      = minimal standalone coding assistant (C)
ai-ezio  = hax-derived workflow-native coding agent (C engine + TypeScript harness)
```

> **Status:** private, pre-implementation. This repository currently contains
> high-level design documents only. See `docs/milestones.md` for the build plan.

## Lineage

ai-ezio is derived from **hax**, a minimalist terminal coding assistant in C,
originally authored by **Oleksandr Chekhovskyi**
(<https://github.com/OleksandrChekhovskyi/hax>). ai-ezio retains hax's core
provider / tool / streaming architecture and adds ai-creed workflow integration
on top. hax is vendored as a git submodule under `vendor/hax`; the only
downstream change to hax itself is a small, isolated, upstreamable protocol
emitter. See [`UPSTREAM.md`](./UPSTREAM.md) and [`NOTICE`](./NOTICE).

## Architecture at a glance

```text
ai-ezio (TypeScript monorepo, pnpm)        vendor/hax (C submodule + emitter patch)
  packages/protocol   JSONL schema            src/protocol/emit.c   hooks turn on_event()
  packages/harness    spawn + lifecycle       --protocol-fd / --control-fd flags
  packages/adapter    ai-whisper glue         (small, isolated, upstreamable)
  packages/cli        `ai-ezio` binary
  build: compile hax -> embed binary -> single installable artifact
```

Protocol transport is inherited file descriptors (events on fd 3, controls on
fd 4); stdout/stderr stay human-only. The transport sits behind a seam so a
Unix socket or stdio framing can be added later without touching protocol logic.

Full design: [`docs/architecture.md`](./docs/architecture.md),
[`docs/protocol.md`](./docs/protocol.md).

## Distribution

ai-ezio ships as a **single artifact** — the hax binary is embedded inside the
ezio bundle, so users install one thing and never manage hax separately. The
final packaging form (Node SEA, `bun build --compile`, or npm prebuilt
per-platform binaries) is decided at Milestone 1.

Supported targets: macOS and Linux.

## License

MIT. ai-ezio carries hax's MIT license and Oleksandr Chekhovskyi's copyright
forward. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
