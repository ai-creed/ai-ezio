# ai-ezio milestones

Re-cast for the hybrid architecture (C engine submodule + TS harness). The C
emitter is part of the protocol milestone (M3), not the foundation.

## M1 — Downstream foundation

- Wire `vendor/hax` as a git submodule pinned to a hax base commit.
- Stand up the pnpm monorepo: `packages/{protocol,harness,adapter,cli}` skeletons.
- ESLint + Prettier + `.editorconfig` (tabs, double quotes, semicolons, trailing
  commas; source-only formatting).
- Build pipeline that compiles hax and embeds the binary into the ezio bundle —
  **pick the final packaging form here** (Node SEA vs `bun build --compile` vs
  npm prebuilt per-platform binaries).
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
- Interactive `/skills`.
- Make missing skills easy to diagnose (`doctor` integration).
- Verify ai-whisper skills can be installed into ai-ezio's expected directory.

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

**Done when:** a programmatic client submits and receives handback text purely
over the protocol, no clipboard, no scraping.

## M5 — ai-whisper adapter

- `packages/adapter` (ships as ai-whisper's `adapter-ai-ezio`).
- Spawn ai-ezio in mounted mode; use the protocol for handoff delivery and
  response capture.
- Run a manual relay handoff end to end.

**Done when:** a single relay handoff runs through ai-ezio via the protocol.

## M6 — Workflow integration

- Widen ai-whisper's hardcoded `"claude" | "codex"` into a shared `AgentType`;
  add ai-ezio.
- Support `whisper collab mount ai-ezio`.
- Support `whisper skill install --target ai-ezio`.
- Run one full ai-whisper workflow with ai-ezio in a role.

**Done when:** ai-ezio is a first-class ai-whisper agent type and completes one
full workflow as a role.

## Open study questions (carried from the plan)

- Final packaging form for the single artifact (resolve in M1).
- How much hax core (if any) needs splitting for clean protocol hooks beyond the
  `on_event` seam.
- Streaming opt-in (`assistant_delta`) and whether `tool_call_delta` is needed.
- Whether ai-whisper should support >2 mounted agents immediately or only allow
  ai-ezio as a replacement role.
- How skills are shared across Claude / Codex / hax / ai-ezio (M2).
- Which generic improvements (esp. the emitter) to propose back to hax upstream.
