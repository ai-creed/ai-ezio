# Changelog

All notable changes to ai-ezio are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Prerelease (`-beta.N`) versions publish to npm under the `beta` dist-tag, not
`latest`: `npm i -g @ai-creed/ai-ezio@beta` (or the unscoped `ai-ezio@beta`).

## [0.4.0] — 2026-07-01

### Added

- **Per-turn `timestamp` and `model` on ezio session records** — each
  `.record.jsonl` row written by `@ai-ezio/session-recorder` now carries an
  end-of-turn ISO-8601 `timestamp` (minted from an injectable clock, stamped at
  turn finalize) and the engine-reported `model` (cached from `status` events,
  omitted when unknown). Downstream telemetry consumers can time-bucket ezio
  token usage by real turn-completion time and attribute it per model, instead of
  collapsing a whole conversation onto the file's mtime. The fields are
  additive — the durable store serializes `timestamp` always and `model` when
  present — with no hax, protocol, or cortex-projection change.

## [0.3.0] — 2026-06-28

### Added

- **`@ai-ezio/subagent` — subagent v0 (delegated-tool dispatch)** — a new
  package that registers a `subagent` delegated tool and services its calls by
  spawning a child hax session on a named profile: linear dispatch (spawn child,
  run task, teardown), cancellation on parent abort, a dispatch timeout, and
  child sessions that get their own MCP host (`registerDelegatedTools` /
  `sendToolResult` are forwarded to the child). Profiles come from the
  `subagents` config section, with defaults seeded from a codex model probe
  whenever codex is usable; `ai-ezio doctor` surfaces the probe result.
  Deferred scope is tracked in `docs/backlog/`.
- **`@ai-ezio/session-hosts` — one factory for the session's host stack** —
  `loadSessionHosts` builds the `DelegatedToolRegistry` (MCP host + subagent
  host) for a Session, including the delegated-timeout backstop, so standalone
  and mounted surfaces wire the same stack the same way.
- **`DelegatedToolProvider` registry in the harness** — a provider interface +
  `DelegatedToolRegistry` that owns delegated-tool routing and provider
  lifecycle. `McpHost` and `SubagentHost` both implement it; the standalone
  REPL now runs through the registry, and provider init failures are isolated
  instead of taking the session down.
- **Per-turn token usage from `Session.submitAndWait`** — the engine-reported
  usage now propagates out of the harness turn API.

### Security

- Pinned transitive `hono` to `>=4.12.25` via a pnpm override.

## [0.2.0-beta.5] — 2026-06-19

### Added

- **`/resume` + `/rename` slash commands** — switch the live session to a past
  one (backed by `Session.resume`, which respawns headless hax with
  `--resume=<id>` under a generation-stamped event pump so a stale child can
  never corrupt the fresh session) and rename sessions via a title store that
  the resume picker merges into its listing.
- **Resume-picker pagination** — 15 sessions per page, `[` / `]` page
  navigation, Ctrl+A to show all.

### Changed

- **README rewritten end-user-first** — install, provider wiring
  (codex/OpenAI/OpenRouter/local), setup wizard, and MCP configuration now lead;
  architecture and build-from-source follow.
- hax submodule synced to upstream (2026-06-15 sync, base `4868d2c`).

### Fixed

- A resume issued while a turn holds the gate now reports **busy** (recoverable
  `EngineBusyError`) instead of tearing the session down.
- Standalone REPL: raw mode is restored after the `/resume` picker closes, the
  picker receives input in whole chunks (arrow keys work), and the banner
  re-renders after a resume respawn.

### Security

- Bumped `esbuild` to `^0.28.1` (GHSA-gv7w-rqvm-qjhr).

## [0.2.0-beta.4] — 2026-06-14

### Added

- **`SlashController` `excludeCommands` option** — the controller constructor now
  accepts `{ excludeCommands }`, dropping the named built-ins (and their aliases)
  from the registry. This lets a host build the controller without `/quit` and
  `/exit` while reusing the same single command set; an excluded `/quit` falls
  through to the standard "unknown command" message.

### Changed

- **Slash machinery relocated to `@ai-ezio/surface`** — `slash`, `skills`,
  `clipboard`, and `transcript-view` moved out of the `@ai-creed/ai-ezio` CLI
  into the shared surface package so the standalone REPL and downstream mounted
  hosts import one `SlashController`. `slash.ts` no longer depends on
  `@ai-ezio/harness` / `@ai-ezio/session-recorder`: its `SlashContext` now uses
  local structural `SlashSession`/`SlashRecorder` interfaces, so surface gains no
  new package dependency. Standalone REPL behavior is unchanged (imports repointed
  only).

These are the `@ai-ezio/surface` seams ai-whisper's mounted adapter consumes to
make ezio's slash commands work inside `whisper collab mount ezio`. Engine: hax
submodule pin unchanged; no hax C change.

## [0.2.0-beta.3] — 2026-06-13

### Added

- **Shared auto-compaction driver** — `createAutoCompactDriver` in
  `@ai-ezio/harness`, an event-driven seam over the existing `Compactor`:
  `assistant_turn_finished.usage` feeds the arming signal, `idle` triggers an armed
  cycle, and `compacting()` lets a host suppress its own output/relay so the
  injected summarize turn never leaks. This is the seam mounted-mode hosts
  (ai-whisper) consume to wire auto-compaction — without it, a mounted session grew
  context unbounded until the provider rejected the request.
- **`callHostRehydration`** promoted to `@ai-ezio/mcp-host` (from the CLI's
  compaction wiring) so any surface can build the cortex project-memory rehydration
  callback over the host's generic tool-discovery surface. The CLI re-exports it
  for back-compat.

### Changed

- The standalone REPL routes its auto-compaction through the shared driver
  (`buildCompactor` is now a thin wrapper over it) — behavior is unchanged; the two
  surfaces no longer maintain separate compaction wiring.

## [0.2.0-beta.2] — 2026-06-11

### Added

- **Ctrl+T / `/transcript` transcript view** in the standalone REPL — a
  model-perspective view (full system prompt, every advertised tool schema, and
  every conversation item) reproducing hax's interactive Ctrl+T under the headless
  architecture. It pages hax's `HAX_TRANSCRIPT` mirror via `$PAGER` (default
  `less -R`), with inline-dump and "no transcript yet" fallbacks. The harness
  exposes `Session.transcriptPath` (set from a caller-minted pre-spawn id) as the
  seam mounted-mode hosts will consume. Mounted-mode (ai-whisper) wiring is a
  downstream follow-up.

## [0.2.0-beta.1] — 2026-06-11

### Added

- **First-class session resume:** `--continue` and `--resume[=ID]` route through
  the unified self-mount (MCP host + compactor + surface stay active) instead of
  falling through to raw-hax passthrough. Bare `--resume` opens an interactive
  session picker, backed by a new `--list-sessions` hax seam. A one-line "resumed"
  notice prints on launch.

### Fixed

- **Markdown rendering:** inline code, bold, links, and emphasis inside list items
  rendered as raw markdown (literal backticks/asterisks) under marked-terminal\@7 on
  marked\@15; list-item content is now inline-parsed.

### Security

- Bumped `esbuild` to `0.25.x` (GHSA-67mh-4wv8-2f99; dev dependency).

## [0.2.0-beta.0] — 2026-06-10

### Added

- **M11 context compaction:** `/compact` command and automatic threshold-based
  compaction, `/usage` context-fullness percentage, a session turn gate, a
  `config.json` compaction section, and the protocol `compact` control +
  `compacted` event.

### Fixed

- MCP server stderr no longer leaks into the terminal (e.g. cortex `[ai-cortex]`
  per-call log lines).
- Harness: no control writes to a dead engine (typed error + EPIPE swallow); a
  bare submit holds the turn gate until its idle; the compaction digest fallback
  excludes the failed summarize attempt.

### Changed

- hax engine synced to upstream base commit `2d98651` (M11 compact seam).
- Packages published under the `@ai-creed` scope with an unscoped `ai-ezio` alias;
  CI runners moved to Node 22/24.

## [0.1.0-beta.0] – [0.1.0-beta.2] — 2026-06-10

Initial public beta bring-up (milestones M1–M10):

- TypeScript harness — spawn hax headless, own the session/turn lifecycle, expose
  the protocol.
- JSONL protocol schema + codec over inherited-fd transport.
- Generic stdio MCP host — spawn/connect servers, policy, namespacing (M9).
- Mounted-REPL surface — banner, markdown, tool calls, usage (M7/M8).
- Session recorder (transcript capture) and the `ai-ezio` CLI.
- Single-bundle distribution with the hax binary embedded; tag-triggered publish
  pipeline (M10).

[0.2.0-beta.3]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.3
[0.2.0-beta.2]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.2
[0.2.0-beta.1]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.1
[0.2.0-beta.0]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.0
[0.1.0-beta.2]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.1.0-beta.2
[0.1.0-beta.0]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.1.0-beta.0
