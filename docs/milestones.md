# ai-ezio milestones

Re-cast for the hybrid architecture (C engine submodule + TS harness). The C
emitter is part of the protocol milestone (M3), not the foundation.

## M1 — Downstream foundation

- Wire `vendor/hax` as a git submodule pinned to a hax base commit.
- Stand up the pnpm monorepo: `packages/{protocol,harness,adapter,cli}` skeletons.
- ESLint + Prettier + `.editorconfig` (tabs, double quotes, semicolons, trailing
  commas; source-only formatting).
- Build pipeline that compiles hax and embeds the binary into the ezio bundle,
  using the decided packaging model: npm main package + per-platform
  `@ai-ezio/hax-<os>-<cpu>` binary packages (optionalDependencies), Node LTS
  runtime, binary resolved via `AI_EZIO_HAX_BIN` → platform package →
  `vendor/hax/build/hax` dev fallback. CI cross-compile matrix can land last.
- `ai-ezio` CLI launches: interactive REPL passthrough + `-p` one-shot, both
  delegating to the embedded hax.
- `ai-ezio --version --json` → ezio version + hax base commit.
- Lineage docs already in place (README, NOTICE, UPSTREAM, AGENTS).

**Done when:** one install produces a working `ai-ezio` that runs hax for humans,
and `--version --json` reports both versions.

## M2 — Skills discoverability

- Study how skills are shared across Claude, Codex, hax, and ai-ezio (open item).
- Document skill directories ai-ezio honors.
- `ai-ezio skill list` / `skill dirs` (+ possibly `skill install`).
- Make missing skills easy to diagnose (`doctor` integration).
- Verify ai-whisper skills can be installed into ai-ezio's expected directory.

> Interactive `/skills` was moved out of M2 to **M4** (mounted mode): the human
> REPL is currently raw hax passthrough, and injecting a `/skills` command needs
> the control/input channel that lands with the protocol (M3) and mounted mode
> (M4). Adding it in M2 would require scraping or growing the hax patch beyond
> the emitter seam (`UPSTREAM.md`). See `docs/skills.md`.

**Done when:** a user can discover, list, and diagnose skills, and an ai-whisper
skill installs into ai-ezio cleanly.

## M3 — Protocol MVP (includes the C emitter)

- Land the hax emitter patch on the `emitter` branch: `src/protocol/emit.c`,
  `--protocol-fd` / `--control-fd` flags (see `UPSTREAM.md`, `docs/protocol.md`).
- `packages/protocol`: JSONL schema, codec, fd transport behind the transport
  seam.
- Emit `ready`, `user_turn_started`, `assistant_turn_started`,
  `assistant_turn_finished`, `idle`, `error` (deltas + tool events as available).
- Control path for `submit` and `interrupt` end to end.
- Normal human REPL behavior unchanged (protocol only active when fds are wired).

**Done when:** the harness drives a full turn over fds with no stdout scraping;
human REPL is byte-for-byte unaffected when the protocol is off.

## M4 — Mounted mode

- `ai-ezio --mount-mode` (protocol fds wired, REPL chrome suppressed).
- Accept programmatic submissions via `submit`; return final response via
  `assistant_turn_finished.content`.
- `copy_last_response` so handback never needs the clipboard.
- `new_conversation`, `status` controls.
- Interactive `/skills` (moved from M2): now that ai-ezio owns a control/input
  channel, surface the discovered-skills list in the REPL. Reuses the M2 skill
  discovery (`ai-ezio skill list`).

**Done when:** a programmatic client submits and receives handback text purely
over the protocol, no clipboard, no scraping.

## M5 — ai-whisper adapter

- `packages/adapter-ai-ezio` **in the ai-whisper repo** (imports
  `@ai-ezio/harness`); ai-ezio's `packages/adapter` placeholder is retired. The
  harness stays workflow-agnostic — workflow glue lives in ai-whisper.
- Spawn ai-ezio in mounted mode; use the protocol for handoff delivery and
  response capture.
- Add the minimum ai-whisper mount-runtime plumbing (an `ai-ezio` `AgentType` +
  submit-strategy that calls `submit()`, idle from the explicit `idle` event) to
  drive one real relay handoff end to end.

**Done when:** a single relay handoff runs through ai-ezio via the protocol.

See `docs/superpowers/specs/2026-06-04-m5-adapter-design.md` for the full design
and the M5/M6 boundary.

## M6 — Workflow integration ✅ (done 2026-06-05)

The agent's workflow **role / agentType is `ezio`** (the project/package/repo
remains `ai-ezio`). Shipped on the ai-whisper `m6-workflow-integration` branch;
see `docs/superpowers/specs/2026-06-05-m6-workflow-integration-design.md` and
`docs/superpowers/plans/2026-06-05-m6-workflow-integration.md`.

- ✅ Widened ai-whisper's hardcoded `"claude" | "codex"` into a single shared
  `AgentType` (`(typeof agentTypes)[number]`) across the broker + CLI surfaces,
  enforced by a drift-prevention guard test so no inline union can creep back.
- ✅ Bound-agent role resolution (replacement model): `ezio` substitutes for a
  role and "the other agent" is resolved from the two bound agents.
- ✅ `whisper collab mount ezio` and `whisper collab tell --target ezio`.
- ✅ Full relay parity: `@@ezio` targeting inbound, `supportsRelayInterception`
  true, ezio-originated `@@` directives recorded with `senderAgent: "ezio"`.
- ✅ `whisper skill install --target ezio` → installs into the engine-visible
  `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills` (helper + CLI boundary).
- ✅ A full `spec-driven-development` workflow runs to terminal `done` with ezio
  as implementer and claude as reviewer over the real stack (only the LLMs
  mocked) — `pnpm run e2e:ai-ezio-workflow`.

**Done when:** ezio is a first-class ai-whisper agent type and completes one
full workflow as a role. **Met.**

## M7 — Mounted ezio REPL parity ✅ (done 2026-06-05)

A mounted `ezio` pane re-creates the hax REPL *look* — a
`▌ ezio › provider · model · effort` banner on start, and a per-turn usage line +
`›` prompt — rendered entirely from protocol events. The engine stays
protocol-native (no REPL re-enabled, no PTY scraping). Spec/plan:
`docs/superpowers/specs/2026-06-05-m7-mounted-repl-parity-design.md`,
`docs/superpowers/plans/2026-06-05-m7-mounted-repl-parity.md`.

- ✅ hax emitter (minimal seam): `status.effort`, an auto-emitted `status` right
  after `ready` in `--mount-mode`, and optional `assistant_turn_finished.usage`
  (omitted when the backend reports `-1`) — surfacing data hax already computes.
- ✅ Protocol: optional `status.effort` + `assistant_turn_finished.usage`,
  documented in `docs/protocol.md`; codec present + absence coverage.
- ✅ Adapter renders the banner once, a usage line (binary-`k` parity with hax's
  `format_tokens`), and a `›` prompt after each turn.
- ✅ Engine-level `test_mount_repl` (real hax + mock) proves auto-status and usage
  present/omitted; the mount e2e asserts the banner + a post-turn prompt.

**Done when:** mounting ezio shows a banner on start + usage/prompt per turn,
fed entirely by protocol events; codex/claude and all M6 behavior unchanged.
**Met.**

## M8 — Mounted ezio display fidelity ✅ (done 2026-06-05)

A mounted `ezio` pane renders like a real coding agent — assistant prose as
**formatted markdown** at turn end, a **thinking spinner** while working, **tool
calls** with an args summary + output preview + **colored diffs**, a clean usage
line on its own line (fixing the M7 usage-glue), red error rendering, and a
magenta `❯` prompt (ASCII `>` fallback). All from protocol events; the engine
stays protocol-native (no REPL re-enable, no PTY scraping). Spec/plan:
`docs/superpowers/specs/2026-06-05-m8-mounted-display-fidelity-design.md`,
`docs/superpowers/plans/2026-06-05-m8-mounted-display-fidelity.md`.

- ✅ Protocol: optional `tool_call_started.args`, `tool_call_finished.output`/
  `isDiff`, documented in `docs/protocol.md`; codec present + absence coverage.
  `tool_call_finished.status` now reflects execution (`ok`/`error`).
- ✅ hax emitter: tool events move to the **dispatch seam** (`agent.c`, after
  `tool->run`) — `emit_tool_started`/`emit_tool_finished` carry args/output/isDiff
  and an execution-accurate status; the stream-hook tool emission + pending-tool
  tracking were removed (net-narrower emit state).
- ✅ Adapter: a pure `mounted-renderer.ts` (+ dependency-free `render-markdown.ts`)
  owns ALL pane presentation; the live-session delegates display and keeps only
  handler forwarding + M6 handback timing. Spinner timer + UTF-8 detection are
  injectable seams for deterministic tests.
- ✅ Engine-level `test_emit`/`test_observer_tool_e2e`/`test_mount_repl` assert
  args/output/isDiff over the real protocol; the mount e2e drives a tool turn and
  asserts the pane renders `⏺ bash` + the tool output.

**Done when:** mounting ezio renders markdown, a spinner, tool calls (args/output/
diffs), a clean usage line, and a `❯` prompt — fed entirely by protocol events;
codex/claude and all M6/M7 behavior unchanged. **Met.**

## M9 — Generic MCP host + unified terminal ✅ (done 2026-06-08)

ezio becomes the ai-\* ecosystem's opinionated coding agent and a **generic MCP
host**: the model can call any configured stdio MCP server's tools (cortex first)
live, mid-turn. Built on a **unified** architecture — hax is always headless and
ezio (TS) always owns the terminal. Spec/plan:
`docs/superpowers/specs/2026-06-08-m9-mcp-host-ecosystem-integration-design.md`,
`docs/superpowers/plans/2026-06-08-m9-mcp-host-ecosystem-integration.md`.

- ✅ hax **host-delegated tools** seam (MCP-agnostic): `register_delegated_tools`
  / `tool_result` controls + a `tool_call_requested` event; the dispatch loop
  emits the request and **blocks** on the control fd for the host's result —
  interrupt-aware and timeout-bounded (`AI_EZIO_DELEGATED_TIMEOUT`, default 120s).
  Delegated output is capped to `output_cap_bytes()` like native tools. Native
  behavior is byte-for-byte identical when nothing is registered.
- ✅ `@ai-ezio/mcp-host`: spawn/connect stdio MCP servers (`@modelcontextprotocol/sdk`),
  `<server>__<tool>` namespacing, schema-aware drift-proof cwd injection,
  config-driven `allow|deny|confirm` policy (destructive defaults deny; confirm
  degrades to deny in mounted), per-call 60s timeout, lifecycle. A shared
  `loadMcpHost` factory is the single both-modes entry point.
- ✅ Unified run architecture: hax always headless; standalone `ezio` self-mounts
  (line-buffered input reader + M7/M8 surface + MCP host). hax stdin/stdout/stderr
  stay ignored.
- ✅ An e2e proves the full round-trip through the **real hax engine** + a stub MCP
  server (register → model calls a delegated tool → request → host routes →
  result → finish).

**Done when:** the model calls a configured MCP server's tool live mid-turn over
the protocol; native behavior unchanged when no tools are registered. **Met.**
(Mounted-mode adapter wiring — one `loadMcpHost` call — lands in the ai-whisper
`adapter-ai-ezio`.)

## Post-M11 (shipped after the milestone plan)

The M1–M11 plan above is complete. Later work is tracked release-by-release in
`CHANGELOG.md` and, for deferred scope, in `docs/backlog/`. Shipped so far:

- **Subagent v0** (`@ai-ezio/subagent`, 0.3.0) — a `subagent` delegated tool
  serviced by spawning a child hax session on a named profile (codex-probed
  default profiles, cancel on parent abort, dispatch timeout). Deferred scope:
  `docs/backlog/2026-06-27-ezio-subagent-v1-backlog.md`.
- **Session host stack** (`@ai-ezio/session-hosts`, 0.3.0) — `loadSessionHosts`
  builds the delegated-tool registry (MCP host + subagent host) for a Session,
  one factory across both run modes.
- **Per-turn telemetry** (0.4.0) — ISO timestamp + engine-reported model on
  every `.record.jsonl` row.

## Open study questions (carried from the plan)

- How much hax core (if any) needs splitting for clean protocol hooks beyond the
  `on_event` seam.
- Streaming opt-in (`assistant_delta`) and whether `tool_call_delta` is needed.
- ~~Whether ai-whisper should support >2 mounted agents immediately or only allow
  ezio as a replacement role.~~ **Resolved in M6:** replacement role (exactly two
  bound agents; ezio usually replaces codex). >2 simultaneous agents is out of
  scope.
- How skills are shared across Claude / Codex / hax / ai-ezio (M2).
- ~~Which generic improvements (esp. the emitter) to propose back to hax
  upstream.~~ **Resolved:** we maintain our own hax fork as ezio's backbone and do
  not upstream; changes stay localized/minimal/rebaseable so the fork can still
  sync with upstream hax (see `UPSTREAM.md`).

## Backlog

- ~~**ezio REPL resume.**~~ ✅ **Done (2026-06-10).** `ai-ezio --continue` /
  `--resume=ID` are now first-class ezio flags routed into the standalone
  self-mount (resume flag forwarded to the headless hax spawn, so the MCP host,
  compactor, and M7/M8 surface stay active); bare `--resume` opens an
  interactive ezio-rendered session picker fed by a new generic
  `hax --list-sessions` JSON seam (no re-deriving hax's private session layout);
  the remaining raw-hax passthrough now degrades loudly. Spec:
  `docs/superpowers/specs/2026-06-10-ezio-repl-resume-design.md`.
