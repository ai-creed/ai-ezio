# ai-ezio

A hax-derived, workflow-native coding agent for the ai-creed / ai-whisper
ecosystem.

ai-ezio is the ai-\* ecosystem's opinionated coding agent and a **generic MCP
host**: it preserves hax's strengths — a fast, small terminal coding assistant —
while adding the machine-controllable behavior needed for mounted, automated
collaboration, and it speaks **MCP** to any ecosystem service (ai-cortex first).
It keeps a good terminal UI for humans, but exposes an explicit machine protocol
so ai-creed and ai-whisper never have to scrape a TUI.

```text
hax      = minimal standalone coding assistant (C)
ai-ezio  = hax-derived workflow-native coding agent + MCP host (C engine + TypeScript harness)
```

> **Status:** public beta — published to npm as `ai-ezio` (`@ai-creed/ai-ezio`,
> `0.2.0-beta.4`). Shipped through M11 (context compaction; generic MCP host +
> unified terminal landed at M9). See `docs/milestones.md` for the build plan.

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
ai-ezio (TypeScript monorepo, pnpm)            vendor/hax (C submodule + emitter patch)
  packages/protocol          JSONL schema         src/protocol/emit.c   hooks turn on_event()
  packages/harness           spawn + lifecycle    --protocol-fd / --control-fd flags
  packages/mcp-host          generic MCP host     (small, isolated, upstreamable)
  packages/surface           mounted REPL render
  packages/session-recorder  transcript capture
  packages/cli               `ai-ezio` binary
  build: compile hax -> per-platform binary packages -> npm `ai-ezio`
  (the ai-whisper adapter is retired here and lives downstream in the ai-whisper repo)
```

Protocol transport is inherited file descriptors (events on fd 3, controls on
fd 4); stdout/stderr stay human-only. The transport sits behind a seam so a
Unix socket or stdio framing can be added later without touching protocol logic.

Full design: [`docs/architecture.md`](./docs/architecture.md),
[`docs/protocol.md`](./docs/protocol.md).

## Distribution

ai-ezio ships as a **single install** — users install one thing and never manage
hax separately. The chosen packaging model: an npm main package (`ai-ezio`,
re-exporting `@ai-creed/ai-ezio`) that pulls in the matching prebuilt hax engine
as a per-platform `@ai-creed/hax-<os>-<cpu>` `optionalDependency`, so the right
binary is fetched for the host at install time.

```sh
npm i -g ai-ezio
```

Supported targets (published per-platform binaries): macOS arm64, macOS x64,
Linux x64, Linux arm64. Requires Node >= 20.

## License

MIT. ai-ezio carries hax's MIT license and Oleksandr Chekhovskyi's copyright
forward. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
