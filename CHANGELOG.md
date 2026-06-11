# Changelog

All notable changes to ai-ezio are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Prerelease (`-beta.N`) versions publish to npm under the `beta` dist-tag, not
`latest`: `npm i -g @ai-creed/ai-ezio@beta` (or the unscoped `ai-ezio@beta`).

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

[0.2.0-beta.2]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.2
[0.2.0-beta.1]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.1
[0.2.0-beta.0]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.2.0-beta.0
[0.1.0-beta.2]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.1.0-beta.2
[0.1.0-beta.0]: https://github.com/ai-creed/ai-ezio/releases/tag/v0.1.0-beta.0
