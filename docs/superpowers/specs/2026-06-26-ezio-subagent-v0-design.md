# ezio subagent (v0) — linear dispatch to a different model/provider

- **Status:** approved (brainstorm 2026-06-26)
- **Scope:** v0 — a single `subagent` delegated tool that runs **one** child hax
  session at a time (linear, no parallel fan-out) on a **named profile** that
  selects a different model and/or provider. Read-only subagents, nested
  subagents, parallel fan-out, and progress streaming are explicitly out of scope
  (v1 backlog).
- **Repos touched:** ai-ezio only — a new `packages/subagent` package, a
  `subagents` section added to `EzioConfig` (`packages/harness/src/config.ts`),
  and two wiring sites in the standalone CLI
  (`packages/cli/src/repl/standalone-runtime.ts`). **No `vendor/hax` change.**
  Mounted (ai-whisper) wiring is a downstream follow-up; the host is built
  mode-agnostic so ai-whisper's `adapter-ai-ezio` can attach it later with the
  same factory + `start(session)` pattern it already uses for the MCP host.
- **References:** `docs/architecture.md`, `docs/protocol.md` (§ M9 host-delegated
  tools), `docs/superpowers/specs/2026-06-08-m9-mcp-host-ecosystem-integration-design.md`,
  `packages/mcp-host/src/host.ts`, `packages/harness/src/session.ts`,
  `packages/harness/src/spawn.ts`.

## Why

ezio should be able to **delegate a self-contained subtask to a smaller/cheaper
model** — or a different vendor entirely — without polluting the parent
conversation's context. Typical use: the parent (e.g. `gpt-5.5` on the `codex`
provider) hands a mechanical or narrow chunk of work to a cheaper model
(`gpt-5-mini`, a local `ollama` model, etc.), gets back a finished answer, and
continues. This is the subagent pattern familiar from Claude Code / Codex,
specialized to ezio's hybrid architecture.

The key realization that makes this cheap to build: **a subagent is just another
host-delegated tool.** The M9 seam already lets ezio (TS) advertise a tool to the
parent model, receive a `tool_call_requested` when the model calls it, run
arbitrary TS, and reply with a `tool_result`. The MCP host already rides this seam
for every ecosystem tool. The subagent rides the same seam — the only new part is
that its "backend" is a **child hax session** instead of an MCP server. hax stays
entirely subagent-agnostic; it only knows "this tool's result comes from the host."

Consequences of that framing:

- **Zero hax C change.** No protocol additions, no new controls/events.
- **Linear is free.** hax dispatches tool calls sequentially, so at most one
  delegated call is ever outstanding (`docs/protocol.md` § M9). v0's "no parallel
  fan-out" is hax's native behavior, not a constraint we must enforce.
- **All product logic in TS**, honoring the engine/harness boundary and the
  "keep the hax fork minimal and rebaseable" rule.

## Decisions (locked at brainstorm)

| Decision | Choice | Why |
| --- | --- | --- |
| Mechanism | `subagent` host-delegated tool (M9 seam) | Reuses shipped infra; zero hax change. |
| Concurrency (v0) | Linear — one child at a time | hax dispatch is sequential; parallel deferred to v1. |
| Dispatch runner | Full **protocol Session** per call (spawn child hax headless, `submitAndWait`, close) | Reuses the battle-tested turn-gate/error/interrupt machinery; structured events enable future streaming, per-turn usage, multi-turn, and subagent-owned MCP. |
| Model/provider selection | **Named profiles, enum-only** | The parent model can't reliably know prices or the user's local auth; ezio owns the catalog. Enum prevents hallucinated model ids. |
| Subagent tool access | Full native hax tools (`read`/`bash`/`write`/`edit`) **plus** the same `mcp.json` ecosystem (child gets its own `loadMcpHost`) | Most capable subagents; accepted the per-dispatch MCP-connect cost. |
| Read-only subagents | **Deferred to v1** | hax has no native-tool gating (tools are a compile-time array of four; only `--raw` removes them all). True read-only needs a hax tool-denylist seam — out of scope for a zero-C-change v0. |
| Working directory | Parent cwd (child edits the same repo) | v0 use case is delegating work on the current repo. Per-profile cwd is v1. |
| Recursion | Child gets the MCP host but **not** the subagent host | No nested subagents in v0. |
| Surface | Minimal — existing tool-call rendering + a one-line summary (elapsed + tokens) + the final text as tool output | No new surface machinery; nested progress streaming is v1. |
| Config location | `subagents` section in `~/.config/ai-ezio/config.json` (extends `EzioConfig`) | Sibling of `mcp.json`; general ezio settings already live here. |
| Wiring scope | Mode-agnostic host; wired into the standalone CLI here. Mounted wiring deferred downstream. | Mirrors how `loadMcpHost` is shared; the ai-whisper adapter lives in another repo. |

## Architecture

A subagent dispatch is one delegated-tool round-trip on the parent session, whose
handler spins up and tears down a fully independent child session.

```text
parent model
   │  calls subagent(task, profile="cheap")
   ▼
hax (parent)  ──fd3: tool_call_requested{callId,name:"subagent",args}──►  ezio
hax (parent)  ◄────────────────── BLOCKS on fd4 ───────────────────────  (interrupt-aware,
                                                                           timeout-bounded)
ezio SubagentHost.handleEvent:
   resolve profile ──► build child env ──► spawn child Session (headless hax)
   attach child MCP host (loadMcpHost, mounted mode, cwd = parent cwd)
   const { content, usage } = await child.submitAndWait(task)
   child.close(); await childMcp.stop()
ezio  ──fd4: tool_result{callId, output: content, status}──►  hax (parent)
hax (parent) unblocks, splices content into history (capped HAX_TOOL_OUTPUT_CAP),
             parent turn continues.
```

Parent and child are separate OS processes with separate fd pairs, so the parent
hax blocking inside the tool call cannot deadlock the child — the Node event loop
is free to drive the child session while the parent waits.

## Components

Each unit has one purpose, a defined interface, and is independently testable.

### `packages/subagent` (new)

- **`SubagentHost`** — mirrors `McpHost`. Interface:
  - `start(session: HostSession): void` — if any profiles are configured,
    registers the single `subagent` delegated tool (schema's `profile` enum built
    from the configured profile names). No profiles → registers nothing (the tool
    is simply unavailable, exactly like an MCP host with no servers).
  - `handleEvent(event: ProtocolEvent): Promise<void>` — acts only on
    `tool_call_requested` where `name === "subagent"`; ignores everything else.
    Also tracks the in-flight child so it can be torn down on cancellation (see
    Error handling).
  - `stop(): Promise<void>` — tears down any in-flight child.
  - Depends on: `@ai-ezio/harness` (Session/spawn), `@ai-ezio/protocol` (types),
    `@ai-ezio/mcp-host` (`loadMcpHost` for the child's tools).
- **profile resolution** — pure functions: `resolveProfile(name, config)` and
  `profileEnv(profile, parentEnv)` mapping a profile to the child's
  `HAX_PROVIDER` / `HAX_MODEL` / `HAX_REASONING_EFFORT` (+ the named key/base-url
  env passed through from the parent env). Pure and unit-tested in isolation.
- **dispatch runner** — the `handleEvent` body: spawn child Session, attach child
  MCP host, run the task to idle, capture content + usage, tear down, reply.

### `EzioConfig.subagents` (extends `packages/harness/src/config.ts`)

Parses and validates the `subagents` section: a `default` profile name and a
`profiles` map. Unknown/malformed entries follow the existing config convention
(skip with a `doctor`-visible note; never throw). Missing section = no profiles =
feature disabled.

### CLI wiring (`packages/cli/src/repl/standalone-runtime.ts`)

At the two Session-creation sites (fresh start ~L65–84 and resume ~L265–342),
construct a `SubagentHost`, fan `session.onEvent` to its `handleEvent` alongside
the recorder and MCP host, and `await subagentHost.start(session)` before the
first submit — the same ordering contract the MCP host already follows.

## Config schema

```jsonc
// ~/.config/ai-ezio/config.json  (sibling of mcp.json; extends EzioConfig)
{
  "compaction": { /* existing — unchanged */ },
  "subagents": {
    "default": "cheap",                 // used when the model omits `profile`
    "profiles": {
      "cheap": {
        "label": "fast grunt work, lower quality",  // surfaced to the model in the tool description
        "provider": "openai",                        // -> HAX_PROVIDER
        "model": "gpt-5-mini",                        // -> HAX_MODEL
        "effort": "low",                             // -> HAX_REASONING_EFFORT (optional)
        "apiKeyEnv": "HAX_OPENAI_API_KEY"            // name of the parent-env var to pass through (optional)
      },
      "local":  { "label": "offline",      "provider": "ollama",
                  "model": "qwen3:8b", "baseUrlEnv": "HAX_OPENAI_BASE_URL" },
      "strong": { "label": "hard subtask", "provider": "openrouter",
                  "model": "anthropic/claude-sonnet-4.6", "apiKeyEnv": "OPENROUTER_API_KEY" }
    }
  }
}
```

Notes:

- **Auth does not transfer.** The parent's `codex` (ChatGPT) login is not usable
  by an `openai`/`openrouter` child; each non-`codex` profile needs its own key
  present in the parent environment, named by `apiKeyEnv`. `ollama`/`llama.cpp`
  need no key.
- **`subagentTimeoutMs`** (optional, top-level under `subagents`, default 300000)
  bounds a single dispatch.

## Tool schema (advertised to the parent model)

```jsonc
{
  "name": "subagent",
  "description": "Delegate a self-contained subtask to a smaller/cheaper model running as an autonomous coding agent in this same repository. The subagent has no prior conversation context — give it complete instructions. Returns the subagent's final answer. Profiles: cheap = fast grunt work, lower quality; local = offline; strong = harder subtask.",
  "parametersSchema": {
    "type": "object",
    "properties": {
      "task":    { "type": "string", "description": "Full, self-contained instructions for the subagent." },
      "profile": { "type": "string", "enum": ["cheap", "local", "strong"] }
    },
    "required": ["task"]
  }
}
```

The `profile` enum and the description's profile list are generated from the
configured profiles (their `label`s). Omitted `profile` resolves to `default`.

## Data flow (one dispatch, detailed)

1. Parent model calls `subagent(task, profile?)`. hax emits `tool_call_requested`
   and blocks on fd4.
2. `SubagentHost.handleEvent`:
   - `profile = resolveProfile(args.profile ?? config.default)`. Unknown profile
     → reply `error` (see Error handling); return.
   - `env = profileEnv(profile, parentEnv)`; missing required key var → reply
     `error`.
   - `child = new Session({...})`; `await child.start({ env, transcriptPath: <child mirror> })`
     (child hax is spawned headless/mount-mode by the harness as usual).
   - `childMcp = loadMcpHost({ mode: "mounted", cwd: parentCwd })`;
     `await childMcp.start(child)` — the child gets the full ecosystem toolset.
     Mounted mode means `confirm` policy degrades to `deny` (no human is present
     at the child).
   - `{ content, usage } = await child.submitAndWait(task)` — the child runs its
     full inner loop (native + MCP tools) to idle.
   - `child.close(); await childMcp.stop()`.
   - `session.sendToolResult(callId, content, "ok")`.
3. hax unblocks, splices `content` into parent history (capped to
   `HAX_TOOL_OUTPUT_CAP`, default 50K, exactly like a native tool), and the parent
   turn continues.

Context isolation: the child's conversation is entirely separate; only its final
text (`assistant_turn_finished.content`) crosses back to the parent. The child's
deltas and inner tool calls are not rendered in the parent terminal in v0.

## Surface (minimal)

Reuse the existing `tool_call_started` / `tool_call_finished` rendering. The host
contributes a one-line summary; the subagent's final answer is shown as the tool
output:

```text
▸ subagent [cheap: gpt-5-mini]  …running
✔ subagent [cheap]  12.3s · 4.2k tok
  <subagent final answer = tool output>
```

Elapsed time and token count come from the child's `assistant_turn_finished.usage`
and are surface-only; the model-visible tool output is the final text alone.

## Error handling & cancellation

| Case | Behavior |
| --- | --- |
| Unknown/invalid `profile` | `tool_result` status `error`: `unknown profile "X"; valid: cheap, local, strong`. Parent turn continues. |
| Missing API key for the profile | `error` result naming the missing env var. |
| Child spawn / protocol failure (`EngineExitedError`) | `error` result; parent session unaffected. |
| Child turn error (`TurnError`) | return the child's error message as an `error` result. |
| Parent interrupt (Esc) mid-dispatch | hax's delegated blocking read is interrupt-aware and aborts the call. `SubagentHost` watches parent events; when the parent turn ends (idle/error) while a child is in-flight, it `child.close()` + `childMcp.stop()` so no orphan child survives. |
| Child runaway / too long | per-dispatch `subagentTimeoutMs` (default 300000) → close child, `error` result. |
| Parent-side block backstop | raise `AI_EZIO_DELEGATED_TIMEOUT` on the **parent** spawn (a subagent run can exceed the 120s default). This weakens the dead-host backstop, which is acceptable because the host stays alive and replies. |

## Testing

- **`SubagentHost` unit** — inject child `spawn`/`transportFactory` (the existing
  Session test seams). Assert: tool registered iff profiles exist; profile
  resolution incl. `default` and unknown; the dispatch happy path replies with the
  child's content; each error-path reply. Mirror `packages/mcp-host/src/host.test.ts`.
- **Profile/config parse** — valid, missing, malformed, clamp-with-note. Mirror
  `packages/harness/src/config.test.ts`.
- **Dispatch e2e** — `HAX_PROVIDER=mock` child for determinism: real child hax
  session, assert content returns and the child is torn down.
- **Cancellation** — interrupt the parent mid-dispatch; assert the child is killed
  and no orphan remains.
- **Parent delegated path** — reuse `packages/harness/src/session.delegated.test.ts`
  patterns to confirm the `tool_call_requested` → `tool_result` round trip.

## Risks & open items

- **`registerDelegatedTools` merge semantics (must verify before coding).** In v0
  the parent session has **both** the MCP host and the subagent host calling
  `registerDelegatedTools`. `docs/protocol.md` says the control "merges" host tool
  defs but is "sent once after `ready`, before the first submit." Verify against
  the emitter (`vendor/hax/src/protocol/emit.c`, submodule checkout) whether
  multiple `register_delegated_tools` controls merge additively. If they do **not**,
  the fallback is a tiny aggregator that collects tool defs from both providers,
  issues a **single** `register_delegated_tools`, and routes each
  `tool_call_requested` to the owning provider by name. (This also keeps display
  ordering deterministic.)
- **Per-dispatch MCP-connect cost (accepted).** Inheriting `mcp.json` spawns and
  connects MCP servers (cortex, etc.) on every dispatch — real latency and process
  churn. v1 optimization: pool/reuse child MCP connections across dispatches.
- **Pinned-engine confirmation.** The capability check that hax has no native-tool
  gating was done against the installed engine (`@ai-creed/hax-darwin-arm64`,
  0.2.0-beta.x); reconfirm against the pinned engine pointer if the engine is
  bumped before this lands.

## v1 backlog (explicitly out of scope)

- Enforced read-only subagents (needs a generic hax tool-denylist seam, e.g.
  `HAX_DISABLE_TOOLS`).
- Nested subagents (give the child a recursion-guarded subagent host).
- Parallel fan-out (multiple children at once — needs a non-hax-blocking dispatch
  model or multiple outstanding delegated calls).
- Nested progress streaming of the child's deltas/tool calls into the parent
  surface.
- Per-profile working directory / isolated worktree per dispatch.
- MCP-connection reuse/pooling across dispatches.
- Mounted (ai-whisper) wiring of the subagent host.
