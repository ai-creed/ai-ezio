# M9 — Generic MCP host + unified terminal ownership

- **Status:** approved (brainstorm 2026-06-08)
- **Milestone:** M9 — make ezio a frontier, opinionated coding agent for the
  ai-\* ecosystem: a generic **MCP host** (cortex first, any stdio MCP server
  next), built on a **unified** run architecture where hax is always headless and
  ezio (TS) always owns the terminal.
- **Repos touched:** ai-ezio (hax fork seam + protocol + new `mcp-host` package +
  CLI + docs). ai-whisper unaffected (it already drives the mounted host path).
- **References:** `docs/architecture.md`, `docs/protocol.md`, `docs/milestones.md`,
  `UPSTREAM.md`, the M4 mount-mode + M7/M8 surface work.

## Why

ezio should be the opinionated coding agent of the ai-\* ecosystem, and the whole
ecosystem (cortex → whisper → 14all → samantha) speaks **MCP**. So "ezio is an MCP
host" is a *core capability*, not a cortex convenience. The model must be able to
recall/record memory and reach other ecosystem services **agentically** — live,
mid-turn — not just receive injected context.

hax is deliberately minimalist: its tool registry is a compile-time array of four
tools (`read`/`bash`/`write`/`edit`, `vendor/hax/src/agent_core.c:48`), tools are
serialized to the provider in C (`build_tools()`,
`vendor/hax/src/providers/openai.c:170`) and dispatched in C
(`dispatch_tool_call()`, `vendor/hax/src/agent_dispatch.c:679`). There is **no MCP
anywhere** in hax and no runtime/plugin path to add tools. So in-loop tool calling
genuinely cannot be done purely in ezio TS — it requires a (small) engine seam.

## Decisions (locked in brainstorm)

| Decision | Choice |
| --- | --- |
| hax ↔ ezio | We maintain our **own hax fork** as ezio's backbone. We do **not** upstream to Oleksandr's hax, but keep the fork **sync-able** (changes stay localized/minimal/rebaseable). Bias hard toward putting behavior in ezio TS; extend hax only when absolutely necessary. |
| Integration mechanism | **Generic MCP host** (rejected the cheaper cortex-only bash-CLI path, which does not generalize to non-CLI MCP servers). |
| Engine seam | One **MCP-agnostic** seam: hax learns "**host-delegated tools**" (a tool whose result comes from the host). hax knows nothing about MCP, servers, or cortex. |
| Protocol — request signal | **Clean separation:** a dedicated `tool_call_requested` event (not a reuse of the display `tool_call_started`). 1 new event + 2 new controls. |
| Run architecture | **Unify both modes**, built together (not phased): hax is **always headless** (stdin/stdout/stderr ignored, speaks only the protocol); ezio (TS) **always owns the terminal**. "Headless" = persistent, multi-turn, interactive `--mount-mode` — **not** one-shot. |
| Standalone input | ezio ports a small **line-buffered** stdin reader (the model ai-whisper already uses); ezio does **not** re-create hax's line editor. |
| Tool permission policy | **Config-driven** per-tool `allow \| deny \| confirm` in `mcp.json`. Defaults: allow the read-ish majority, deny the known-destructive set (cortex `purge`/`trash`/`promote`). `confirm` prompts only in standalone (a human is present) and degrades to `deny` in mounted. |
| MCP host config | A standard `{ "mcpServers": { … } }` JSON file at `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/mcp.json` (matches the M6 skills-dir convention; users can copy from a Claude config). |

## Architecture

ezio owns the terminal in **both** modes; hax is a persistent, terminal-less
engine behind the protocol fds. The MCP host sits in ezio's loop and services
delegated tool calls.

```
┌─ ezio CLI (TS) — owns the terminal in BOTH modes ─────────────────────────┐
│  ┌ input reader ┐   ┌ surface (M7/M8) ┐   ┌ mcp-host (NEW) ──────────────┐ │
│  │ line-buffered │   │ renders events   │   │ spawn+connect stdio servers │ │
│  │ → submit(str) │   │ → terminal        │   │ tools/list, namespacing,    │ │
│  └───────────────┘   └──────────────────┘   │ register w/ hax, route calls│ │
│   standalone only ▲       both modes ▲       │ cwd-inject, policy, lifecycle│ │
│  (mounted: host app provides input)          └──────┬───────────────────────┘ │
│                   harness Session (protocol pump)    │                         │
└────────────┬─────────────────────────────────┬──────┼─────────────────────────┘
  control fd  │ submit / interrupt /            │ events fd       ▲ tool_result
              │ register_delegated_tools (NEW)  ▼ (incl.          │ (NEW control)
              │                            tool_call_requested)   │
┌─ hax (headless engine, our fork) — ONE new seam ────────────────┴──────────┐
│  delegated_tools registry (defs only, no run())                            │
│  dispatch: native → run() in C  |  delegated → emit tool_call_requested,   │
│            BLOCK on control fd for tool_result (interrupt + timeout aware)  │
│  knows nothing about MCP — only "this tool's result comes from the host"    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Components & contracts

1. **hax delegated-tool seam** (C, minimal). *Does:* advertise host-provided tool
   defs to the model alongside native tools; on a delegated call emit
   `tool_call_requested` and block for a `tool_result` over the control fd.
   *Depends on:* the protocol fds. *Generic* — no MCP knowledge, so it stays
   small and rebaseable against upstream hax.
2. **`packages/mcp-host`** (new TS — the product surface). *Does:* load config,
   spawn/connect stdio MCP servers (`@modelcontextprotocol/sdk`), `tools/list`,
   register namespaced defs with hax, service `tool_call_requested`, inject
   `worktreePath`/cwd, enforce policy, manage server lifecycle. *Depends on:* the
   harness `Session`. *Used by:* the CLI in both modes.
3. **input reader** (TS, standalone only). *Does:* line-buffered stdin →
   `submit(string)`. Ported from ai-whisper's `live-session.ts` line buffer.
4. **surface** (TS, exists). *Does:* render protocol events. Unchanged — delegated
   tool calls arrive as ordinary `tool_call_started/finished` display events and
   render for free.

## The hax seam + protocol contract

**Two new controls (harness → hax), one new event (hax → harness).**

```jsonc
// control, sent ONCE after `ready`, before the first `submit`:
{ "type": "register_delegated_tools",
  "tools": [ { "name": "cortex__recall_memory",
               "description": "…",
               "parameters_schema": { /* JSON Schema */ } } ] }

// event, emitted mid-turn ONLY for delegated tools:
{ "type": "tool_call_requested", "call_id": "abc",
  "name": "cortex__recall_memory", "args": { /* model-supplied */ } }

// control, the host's reply to a tool_call_requested:
{ "type": "tool_result", "call_id": "abc", "output": "…", "status": "ok" } // | "error"
```

**hax side — the entire seam:**

- **Registry:** a `delegated_tools` table beside the static `TOOLS[]`, populated
  from `register_delegated_tools`, carrying **defs only (no `run()`)**, merged into
  the session's advertised tool table so they serialize via the existing
  `build_tools()` indistinguishably from native tools.
- **Dispatch branch** (`dispatch_tool_call`, `agent_dispatch.c:679`): a tool is
  "delegated" if it is in that table. Native → `t->run()` in C, unchanged.
  Delegated → emit `tool_call_requested`, then **block-read the control fd** for a
  `tool_result` with the matching `call_id`, build `ITEM_TOOL_RESULT` from it,
  return. The existing display `tool_call_started`/`tool_call_finished` still fire
  around dispatch (`agent.c:1209`/`1227`).
- **Sequence per delegated call:** `tool_call_started` (display) →
  `tool_call_requested` (delegation) → block → host `tool_result` →
  `tool_call_finished` (display).
- **Safety of the blocking read** (the one new engine behavior):
  - **Interrupt-aware:** an `interrupt` (Esc / host) arriving instead of a result
    aborts the call → synthesized `[interrupted]` result (reuses the existing
    `interrupt_settle`/`interrupt_requested` path); conversation stays well-formed.
  - **Timeout-bounded:** the host owns the *primary* timeout — it normally always
    replies with a `tool_result`, returning `status:"error"` if its own per-call
    timeout (**default 60s**) fires. hax keeps a **generous backstop** (**default
    120s**, override `AI_EZIO_DELEGATED_TIMEOUT`) purely so a *dead* host cannot
    hang the loop → synthesized error result the model can recover from. No
    deadlock path. The agent never hangs on a slow/stuck MCP call.
  - **No concurrency:** hax dispatches tool calls **sequentially**
    (`agent.c:1197`), so there is **at most one outstanding delegated call**; the
    `call_id` match is a sanity check, not a correlation map.
  - **Invariant:** if `register_delegated_tools` never arrives, the delegated path
    is unreachable and native behavior is byte-for-byte identical.

**Why this respects "minimal hax":** the engine learns one generic concept — *a
tool whose result comes from the host*. MCP, namespacing, cwd injection, policy,
and server lifecycle are entirely ezio's. The C delta is one registry table, one
dispatch branch, and one blocking-read-with-interrupt/timeout.

## The MCP host (`packages/mcp-host`)

- **Startup ordering (load-bearing):** spawn headless hax → await `ready` → host
  connects servers + `tools/list` + sends `register_delegated_tools` → **then**
  enable input. The first turn already has the tools. Per-server connect timeout;
  register whatever connected, skip the rest. **Startup is silent** — health is
  surfaced **only on failure**: a server that fails to connect gets a one-line
  warning, and a failed delegated call renders an error in the pane. Successful
  connects stay silent.
- **Namespacing:** advertise `<server>__<tool>` (e.g. `cortex__recall_memory`);
  keep a `name → (server, tool)` routing map. hax and the model see unique names.
- **Auto-injection:** fill cortex's `worktreePath`/`path` from the session cwd
  before forwarding, so the model never supplies them and they cannot drift. Host
  policy, invisible to hax and the model.
- **Result mapping:** MCP content blocks → the `tool_result.output` string the
  model sees; MCP `isError` → `status:"error"`. Large outputs reuse hax's capping.
- **Permission policy:** per-tool `allow | deny | confirm` from `mcp.json`.
  Defaults allow the read-ish majority and deny the known-destructive set; a
  `deny` hit returns an error result explaining the block (so the model learns and
  does not retry blindly). `confirm` prompts in standalone, degrades to `deny` in
  mounted.

### Config

```jsonc
// ${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/mcp.json
{ "mcpServers": {
    "cortex":  { "command": "ai-cortex", "args": ["mcp"] },
    "whisper": { "command": "…", "args": ["…"] }
  },
  "toolPolicy": {            // optional overrides; sensible defaults otherwise
    "cortex__purge_memory": "deny",
    "cortex__trash_memory": "deny"
  } }
```

## Standalone unification (the CLI change)

Replace M1's exec-passthrough with: spawn **headless** hax (`--mount-mode`) → wire
`Session` + surface + the ported **line-buffered input reader** + the MCP host. The
human REPL loop = read line → `submit` → render streamed events → prompt again.
Ctrl-C → `interrupt`; Ctrl-D → exit. The `-p` one-shot path is preserved via
`submitAndWait`. From the human's seat the experience is unchanged: a persistent,
interactive, multi-turn REPL — only *who draws it* changes (ezio's surface, which
already renders the mounted pane, instead of hax's built-in REPL chrome).

## Failure handling & edge cases (each path resolves the blocking read)

- MCP server fails at boot → skip its tools; ezio runs without them.
- Server crashes mid-session / call to a down server → host returns
  `tool_result{status:"error"}`; mark down, optional reconnect.
- Model sends bad args → MCP server's tool error → forwarded as an error result.
- hax-side timeout / `interrupt` during a delegated call → synthesized
  error/`[interrupted]` result.
- `deny` policy hit → explanatory error result (no blind retry).
- Name collision across servers → `<server>__<tool>` namespacing.
- Standalone Ctrl-C/Esc → `interrupt`; Ctrl-D → exit.
- No config / no servers → no `register_delegated_tools`; native behavior identical.

## Testing strategy (TDD)

- **hax engine:** `HAX_PROVIDER=mock` script that calls a delegated tool → assert
  `tool_call_requested` is emitted, hax blocks for `tool_result`, and builds the
  result item; plus interrupt-during-delegated and timeout cases. Extend
  `tests/` per hax's harness (`tests/meson.build`).
- **mcp-host:** unit tests against a **stub MCP server** — registration,
  namespacing, routing, cwd injection, policy (allow/deny/confirm), result/error
  mapping, server-crash handling.
- **e2e:** real hax (mock provider) + harness + stub server → full delegated
  round-trip renders end to end (mirrors the existing mount e2e).
- **input reader:** port ai-whisper's line-buffer tests (backspace/Ctrl-C/Enter).

## Documentation updates (part of this milestone)

ezio's positioning and the hax-fork reality both changed; docs must catch up:

- **`docs/protocol.md`** — the new `tool_call_requested` event +
  `register_delegated_tools`/`tool_result` controls (documented **before** code,
  per working-agreement #4).
- **`docs/architecture.md`** — unified terminal-ownership model (headless hax /
  ezio owns the terminal in both modes) + the MCP host + delegated-tool seam.
- **`docs/milestones.md`** — add **M9**.
- **`README.md` / `AGENTS.md`** — ezio's purpose/positioning as the ecosystem's
  opinionated MCP-host agent; the sanctioned hax-extension areas now include the
  delegated-tool seam.
- **`UPSTREAM.md`** — the maintained-fork-that-stays-sync-able stance (supersedes
  "upstreamable").

## Scope / non-goals

- **In scope:** the generic delegated-tool seam, the `mcp-host` package, cortex as
  the first configured server, standalone unification + input reader, config +
  policy, the doc updates.
- **Out of scope (future):** streaming delegated-tool output (results arrive
  whole); non-stdio MCP transports (http/SSE); MCP resources/prompts (tools only);
  a rich standalone line editor beyond line-buffered (history/multiline) — adopt
  later if needed; passive memory hooks (rehydrate-at-start / capture-at-end) —
  complementary, can be a small follow-on once the agentic path lands.

## Resolved during brainstorm

- **Default deny-list:** curate later — not load-bearing for the design. Ship a
  conservative default (deny `purge`/`trash`/`promote`) and refine once the host
  is real.
- **Timeout:** host per-call default **60s** (returns an error result); hax
  blocking-read backstop default **120s** (`AI_EZIO_DELEGATED_TIMEOUT`) so a dead
  host can't hang the loop. The agent never hangs on a timed-out call.
- **Server health surfacing:** silent on success; **surface only on
  failure/error** (connect failure → one-line warning; failed call → error in the
  pane).
