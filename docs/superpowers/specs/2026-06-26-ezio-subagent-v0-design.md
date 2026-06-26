# ezio subagent (v0) — linear dispatch to a different model/provider

- **Status:** approved (brainstorm 2026-06-26)
- **Scope:** v0 — a single `subagent` delegated tool that runs **one** child hax
  session at a time (linear, no parallel fan-out) on a **named profile** that
  selects a different model and/or provider. Works **zero-config for codex users**:
  built-in profiles are seeded from the live `codex debug models` catalog, and an
  optional `subagents` config block overrides/extends them. Read-only subagents,
  nested subagents, parallel fan-out, and progress streaming are explicitly out of
  scope (v1 backlog).
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
(`gpt-5.4-mini` on the same codex login, a local `ollama` model, etc.), gets back a
finished answer, and continues. This is the subagent pattern familiar from Claude
Code / Codex, specialized to ezio's hybrid architecture.

The key realization that makes this cheap to build: **a subagent is just another
host-delegated tool.** The M9 seam already lets ezio (TS) advertise a tool to the
parent model, receive a `tool_call_requested` when the model calls it, run
arbitrary TS, and reply with a `tool_result`. The MCP host already rides this seam
for every ecosystem tool. The subagent rides the same seam — the only new part is
that its "backend" is a **child hax session** instead of an MCP server. hax stays
entirely subagent-agnostic; it only knows "this tool's result comes from the host."

To keep the common case friction-free, ezio seeds **built-in default profiles**
from the user's live codex model catalog (`codex debug models`) when codex is
usable, so a codex user gets working cheap/standard/strong tiers with **no config
at all**; the optional `subagents` config block only overrides or extends that
catalog.

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
| Zero-config defaults | **Built-in profiles seeded from `codex debug models`** (when codex is usable); the optional `subagents` config merges on top | The common case (a codex login) gets working subagent tiers with no config; seeding from the live catalog keeps model ids valid and current. |
| Subagent tool access | Full native hax tools (`read`/`bash`/`write`/`edit`) **plus** the same `mcp.json` ecosystem (child gets its own `loadMcpHost`) | Most capable subagents; accepted the per-dispatch MCP-connect cost. |
| Read-only subagents | **Deferred to v1** | hax has no native-tool gating (tools are a compile-time array of four; only `--raw` removes them all). True read-only needs a hax tool-denylist seam — out of scope for a zero-C-change v0. |
| Working directory | Parent cwd (child edits the same repo) | v0 use case is delegating work on the current repo. Per-profile cwd is v1. |
| Recursion | Child gets the MCP host but **not** the subagent host | No nested subagents in v0. |
| Surface | Minimal — existing tool-call rendering + a one-line summary (elapsed + tokens) + the final text as tool output | No new surface machinery; nested progress streaming is v1. |
| Config location | Optional `subagents` section in `~/.config/ai-ezio/config.json` (extends `EzioConfig`) — overrides/extends the built-in catalog | Sibling of `mcp.json`; general ezio settings already live here. |
| Wiring scope | Mode-agnostic host; wired into the standalone CLI here. Mounted wiring deferred downstream. | Mirrors how `loadMcpHost` is shared; the ai-whisper adapter lives in another repo. |

## Architecture

A subagent dispatch is one delegated-tool round-trip on the parent session, whose
handler spins up and tears down a fully independent child session.

```text
parent model
   │  calls subagent(task, profile="gpt-5.4-mini")
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
  - `start(session: HostSession): Promise<void>` — builds the profile catalog
    (built-in codex seed + user config), and if it is non-empty registers the single
    `subagent` delegated tool (schema's `profile` enum built from the catalog's
    profile names). Empty catalog → registers nothing (the tool is simply
    unavailable, exactly like an MCP host with no servers).
  - `handleEvent(event: ProtocolEvent): Promise<void>` — acts only on
    `tool_call_requested` where `name === "subagent"`; ignores everything else.
    Also tracks the in-flight child so it can be torn down on cancellation (see
    Error handling).
  - `stop(): Promise<void>` — tears down any in-flight child.
  - Depends on: `@ai-ezio/harness` (Session/spawn), `@ai-ezio/protocol` (types),
    `@ai-ezio/mcp-host` (`loadMcpHost` for the child's tools).
- **profile catalog** — builds the effective profile map by merging two sources:
  1. **built-in codex seed** — when codex is usable (the `codex` CLI is on `PATH`
     and `~/.codex/auth.json` exists), run `codex debug models`, parse the JSON, keep
     models with `visibility === "list"` and `supported_in_api === true`, and emit
     one profile per model slug (`{ provider: "codex", model: <slug> }`, effort left
     at the model default). The probe runs once per session and is cached; any
     failure (CLI missing, non-zero exit, parse error, format drift) skips the seed
     with a `doctor`-visible note and never throws.
  2. **user config** — the optional `subagents.profiles` map, which overrides a
     seeded slug (e.g. to pin effort) or adds new cross-provider profiles. User
     entries win on name collision.
- **profile resolution** — pure functions: `resolveProfile(name, catalog)` and
  `profileEnv(profile, parentEnv)` mapping a profile to the child's
  `HAX_PROVIDER` / `HAX_MODEL` / `HAX_REASONING_EFFORT` (+ the named key/base-url
  env passed through from the parent env). Pure and unit-tested in isolation.
- **dispatch runner** — the `handleEvent` body: spawn child Session, attach child
  MCP host, run the task to idle, capture content + usage, tear down, reply.

### `EzioConfig.subagents` (extends `packages/harness/src/config.ts`)

Parses and validates the optional `subagents` section: a `default` profile name, a
`profiles` map (overrides/extends the built-in codex seed), and `subagentTimeoutMs`.
Unknown/malformed entries follow the existing config convention (skip with a
`doctor`-visible note; never throw). Missing section = built-in codex seed only (or,
when codex is not usable, an empty catalog = feature disabled).

### CLI wiring (`packages/cli/src/repl/standalone-runtime.ts`)

At the two Session-creation sites (fresh start ~L65–84 and resume ~L265–342),
construct a `SubagentHost`, fan `session.onEvent` to its `handleEvent` alongside
the recorder and MCP host, and `await subagentHost.start(session)` before the
first submit — the same ordering contract the MCP host already follows.

## Profile catalog & config schema

The `subagents` block is **optional**. With codex usable and no config, the catalog
is seeded entirely from `codex debug models` — one profile per list-visible model
slug. As of this writing a typical codex login yields:

| Profile (slug) | Tier | Source |
| --- | --- | --- |
| `gpt-5.5` | frontier | seeded (`visibility: list`) |
| `gpt-5.4` | strong | seeded (`visibility: list`) |
| `gpt-5.4-mini` | cheapest / fastest | seeded (`visibility: list`) |

(`codex-auto-review` and any other `visibility: hide` / non-API model are excluded.)

A config block overrides a seeded slug (e.g. to pin effort) or adds cross-provider
profiles:

```jsonc
// ~/.config/ai-ezio/config.json  (sibling of mcp.json; extends EzioConfig)
{
  "compaction": { /* existing — unchanged */ },

  // Entirely optional. Omit it and codex users still get the seeded catalog
  // (gpt-5.5, gpt-5.4, gpt-5.4-mini) from `codex debug models`.
  "subagents": {
    "default": "gpt-5.4-mini",          // when the model omits `profile` (default: cheapest seeded model)
    "subagentTimeoutMs": 300000,        // per-dispatch budget (optional)
    "profiles": {
      // Override a seeded codex slug — e.g. force low effort on the mini for cheap grunt work:
      "gpt-5.4-mini": { "provider": "codex", "model": "gpt-5.4-mini", "effort": "low" },

      // Add cross-provider tiers (each non-codex provider needs its own key):
      "local":  { "label": "offline", "provider": "ollama",
                  "model": "qwen3:8b", "baseUrlEnv": "HAX_OPENAI_BASE_URL" },
      "claude": { "label": "hard subtask", "provider": "openrouter",
                  "model": "anthropic/claude-sonnet-4.6", "apiKeyEnv": "OPENROUTER_API_KEY" }
    }
  }
}
```

Profile fields: `provider` (→ `HAX_PROVIDER`), `model` (→ `HAX_MODEL`), `effort`
(optional → `HAX_REASONING_EFFORT`), `apiKeyEnv` / `baseUrlEnv` (optional — names of
parent-env vars passed through to the child), `label` (optional — a hint surfaced to
the model in the tool description; seeded codex profiles default their label to the
model's `display_name`).

Notes:

- **Default profile.** When the user sets no `default`, it is the cheapest seeded
  codex model (the `*-mini` slug if present, else the lowest-tier list model).
  Delegating implies offloading cheap work; the model can still name a stronger slug
  for a hard subtask. With no seed and no user `default`, the first user profile is
  used.
- **Auth does not transfer.** The parent's `codex` login is reused only by
  `provider: codex` profiles (the seeded ones). An `openai`/`openrouter` child needs
  its own key present in the parent environment, named by `apiKeyEnv`.
  `ollama`/`llama.cpp` need no key.
- **`subagentTimeoutMs`** (optional, default 300000) bounds a single dispatch.

## Tool schema (advertised to the parent model)

```jsonc
{
  "name": "subagent",
  "description": "Delegate a self-contained subtask to a smaller/cheaper model running as an autonomous coding agent in this same repository. The subagent has no prior conversation context — give it complete instructions. Returns the subagent's final answer. Prefer the smallest profile that can do the job; name a stronger one only for a hard subtask. Profiles: gpt-5.4-mini = smaller, faster, cheapest; gpt-5.4 = strong; gpt-5.5 = frontier.",
  "parametersSchema": {
    "type": "object",
    "properties": {
      "task":    { "type": "string", "description": "Full, self-contained instructions for the subagent." },
      "profile": { "type": "string", "enum": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] }
    },
    "required": ["task"]
  }
}
```

The `profile` enum and the description's profile list are generated at startup from
the effective catalog (built-in codex seed + user config) — the example above
reflects a typical codex login. Omitted `profile` resolves to `default` (the
cheapest seeded model unless the user overrides it).

## Data flow (one dispatch, detailed)

1. Parent model calls `subagent(task, profile?)`. hax emits `tool_call_requested`
   and blocks on fd4.
2. `SubagentHost.handleEvent`:
   - `profile = resolveProfile(args.profile ?? catalog.default)`. Unknown profile
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
▸ subagent [gpt-5.4-mini]  …running
✔ subagent [gpt-5.4-mini]  12.3s · 4.2k tok
  <subagent final answer = tool output>
```

Elapsed time and token count come from the child's `assistant_turn_finished.usage`
and are surface-only; the model-visible tool output is the final text alone.

## Error handling & cancellation

| Case | Behavior |
| --- | --- |
| `codex debug models` probe fails (CLI missing / bad exit / parse error / drift) | Skip the codex seed with a `doctor`-visible note; fall back to user-config profiles only. If that leaves an empty catalog, the `subagent` tool is not registered. Never blocks or fails session startup. |
| Unknown/invalid `profile` | `tool_result` status `error`: `unknown profile "X"; valid: <catalog names>`. Parent turn continues. |
| Missing API key for the profile | `error` result naming the missing env var. |
| Child spawn / protocol failure (`EngineExitedError`) | `error` result; parent session unaffected. |
| Child turn error (`TurnError`) | return the child's error message as an `error` result. |
| Parent interrupt (Esc) mid-dispatch | hax's delegated blocking read is interrupt-aware and aborts the call. `SubagentHost` watches parent events; when the parent turn ends (idle/error) while a child is in-flight, it `child.close()` + `childMcp.stop()` so no orphan child survives. |
| Child runaway / too long | per-dispatch `subagentTimeoutMs` (default 300000) → close child, `error` result. |
| Parent-side block backstop | raise `AI_EZIO_DELEGATED_TIMEOUT` on the **parent** spawn (a subagent run can exceed the 120s default). This weakens the dead-host backstop, which is acceptable because the host stays alive and replies. |

## Testing

- **Catalog seeding unit** — feed a captured `codex debug models` JSON fixture
  (inject the probe runner): assert list+API models become profiles, hidden/non-API
  are dropped, slugs map to `{provider:"codex", model:slug}`, and a probe
  failure/garbage output yields an empty seed + note (never throws).
- **Catalog merge unit** — user `profiles` override a seeded slug by name and add new
  ones; `default` resolution picks the cheapest seeded model when unset.
- **`SubagentHost` unit** — inject child `spawn`/`transportFactory` (the existing
  Session test seams). Assert: tool registered iff the catalog is non-empty; profile
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
- **codex catalog seeding (shell-out).** Seeding runs `codex debug models` (a
  ~140 KB JSON dump) once per session, gated on codex being usable. Risks: startup
  latency (mitigated by single-run caching + running it lazily/off the critical
  path before the first submit), output-format drift (mitigated by defensive parsing
  + graceful skip), and staleness within a long session (accepted — re-seed on next
  launch). The probe must never block or fail session startup. Open question: is the
  seed gated strictly on the parent being on `provider: codex`, or run whenever codex
  is usable regardless of the parent provider? (Leaning: run whenever codex is usable
  — codex profiles work via the codex login independent of the parent's provider.)
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
- Cross-session catalog caching (TTL'd `codex debug models` result) and auto-seed for
  non-codex providers (e.g. an OpenRouter model list).
- Mounted (ai-whisper) wiring of the subagent host.
