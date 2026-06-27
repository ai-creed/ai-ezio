# ezio subagent — v1 backlog

Status: backlog (not scheduled). Captures the work explicitly deferred out of the
shipped subagent **v0** (`docs/superpowers/specs/2026-06-26-ezio-subagent-v0-design.md`).

v0 recap: a `subagent` host-delegated tool (M9 seam, zero hax C change) that
dispatches **one** child at a time on a **named profile**, spawning a full
headless-hax protocol Session per call (`submitAndWait`, then close). Profiles are
seeded from the live `codex debug models` catalog and overridable via an optional
`subagents` config block. The host is mode-agnostic and is now wired into **both**
run modes: the standalone ezio CLI and (via the `DelegatedToolRegistry` refactor +
the `adapter-ai-ezio` migration) ai-whisper's mounted mode.

> Note: "Mounted wiring" was listed as deferred in the v0 spec but is now **done**
> — delivered by the delegated-tool-registry refactor and the ai-whisper adapter
> migration (PR2). It is intentionally **not** in this backlog.

## Backlog items

Ordered roughly by value/independence. Each is independently shippable.

### 1. Read-only subagents (needs a hax seam)

The only item that requires a hax C change, and the most-requested capability.

- **Why deferred:** hax has no native-tool gating. Its tools are a compile-time
  array of four (`read`/`bash`/`write`/`edit`); the only lever today is `--raw`,
  which removes *all* of them. A v0 subagent therefore always gets the full
  destructive toolset.
- **What's needed:** a generic, MCP-agnostic hax tool-denylist (or allowlist)
  seam — e.g. a control/env that disables named native tools for a session —
  surfaced so the harness can spawn a child with `write`/`edit`/`bash` denied.
  Keep it minimal and rebaseable per `UPSTREAM.md`; this is a sanctioned
  engine extension (a generic capability, not subagent-specific).
- **Product shape:** a profile field (e.g. `readOnly: true`) and/or a distinct
  `subagent_readonly` tool, so the parent can delegate "investigate and report"
  work that provably cannot mutate the repo.

### 2. Parallel fan-out

v0 is linear by construction: hax dispatches tool calls sequentially, so at most
one delegated call is ever outstanding — "no parallel fan-out" is hax's native
behavior, not something v0 enforces.

- **What's needed:** a way for one parent turn to launch N children concurrently.
  Two candidate shapes:
  - a **batch tool** (`subagent_batch([{task, profile}, ...])`) that the host
    fans out across N child Sessions concurrently and returns the joined results;
    or
  - allowing **multiple outstanding delegated calls** in hax so the parent model
    can issue several `subagent` calls in one turn (larger engine change).
- The host already spawns an independent Session per call, so the concurrency
  itself is cheap on the TS side; the constraint is purely the dispatch protocol.
- Consider a concurrency cap + aggregated usage/elapsed reporting.

### 3. Nested subagents

v0 gives the child the MCP host but **not** the subagent host (a deliberate
recursion guard) — no nested delegation.

- **What's needed:** allow a child to itself dispatch subagents, with a depth
  limit and a cycle/budget guard to prevent runaway trees. Pairs naturally with
  per-call token/elapsed budgets.

### 4. Per-profile working directory

v0 always runs the child in the **parent cwd** (child edits the same repo).

- **What's needed:** a per-profile `cwd` (and/or git-worktree isolation) so a
  child can operate on an isolated copy — important once parallel fan-out lands,
  to avoid concurrent children clobbering each other's edits.

### 5. Multi-turn subagents

v0 is single-shot: one `submitAndWait` per call, then the child Session closes.

- **What's needed:** keep a child Session alive across multiple parent calls
  (a handle/session id the parent can address), enabling iterative refinement
  instead of re-spawning + re-priming context each time. The full-Session
  dispatch runner was chosen partly to make this reachable.

### 6. Progress streaming + richer surface

v0 surface is intentionally minimal: existing tool-call rendering + a one-line
summary (elapsed + tokens) + the child's final text as the tool output.

- **What's needed:** nested progress streaming — surface the child's live events
  (assistant deltas, its own tool calls) under a collapsible/indented block,
  rather than only the final answer. The per-call Session already emits the
  structured events; this is a surface/rendering task.

### 7. Subagent-owned / scoped MCP

v0 gives the child its own `loadMcpHost` from the **same** `mcp.json` as the
parent (full ecosystem access, accepting the per-dispatch MCP-connect cost).

- **What's needed:** per-profile MCP scoping — restrict or extend which MCP
  servers/tools a child profile may use (e.g. a research profile that gets the
  docs MCP but not write-capable servers). Composes with read-only (item 1).

### 8. Profile UX

Smaller quality-of-life work around the profile catalog:

- A command to **list** the effective profile catalog (seeded + user config) and
  show which source each profile came from — surfaced in `doctor`.
- Better diagnostics when the `codex debug models` probe fails or drifts (the
  catalog already degrades gracefully; make the *why* visible).
- Non-codex seeding paths (e.g. seed from other providers' model catalogs) so a
  user without a codex login still gets sensible default tiers.

## Cross-cutting

- **Budgets:** per-call (and per-tree, once nested) token/time budgets — most
  relevant once parallel fan-out and nesting exist.
- **UPSTREAM discipline:** only item 1 touches hax; keep any seam generic and
  rebaseable. Everything else stays in the TS harness, honoring the
  engine/harness boundary.
