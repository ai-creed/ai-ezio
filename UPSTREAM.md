# Upstream relationship

ai-ezio is a **downstream** product derived from **hax**. We maintain our own
**fork** of hax (`ai-creed/hax`) that carries the downstream changes; the
original hax repo is treated as a read-only **sync source**, not a merge target.
We do not assume the original author wants our changes upstreamed — the
`agent_observer` seam is *designed* to be upstreamable, but the fork's viability
does not depend on it ever being merged.

## Repositories

| Role                 | Repo                                                      |
| -------------------- | --------------------------------------------------------- |
| Downstream fork (hax)| `git@github.com:ai-creed/hax.git` (private) — carries `emitter` |
| Sync source (orig.)  | `https://github.com/OleksandrChekhovskyi/hax` (read-only) |
| Downstream product   | `ai-creed/ai-ezio` (private)                              |
| Base commit          | `2d98651` (synced 2026-06-10; original derivation `8fd139b`, 2026-05-29) |

## How hax is consumed

hax is vendored as a **git submodule** at `vendor/hax`, pointing at our fork
`ai-creed/hax`. The fork carries small, isolated downstream changes on the
`emitter` branch on top of the upstream base:

- the **protocol emitter** (M3+), and
- the **host-delegated tools** seam (M9): an MCP-agnostic mechanism letting the
  harness advertise tools whose results come from the host over the protocol
  (`register_delegated_tools`/`tool_result` controls, `tool_call_requested` event,
  a delegated dispatch branch). hax knows nothing about MCP — that keeps the seam
  generic and rebaseable.

Each change stays localized so the fork can keep syncing with upstream hax.

```text
vendor/hax  (submodule url: git@github.com:ai-creed/hax.git, branch = emitter)
  remote: origin        -> github.com/ai-creed/hax           (our fork; push here)
  remote: hax-upstream  -> github.com/OleksandrChekhovskyi/hax (read-only sync source)
  branch: emitter       -> upstream base + agent_observer seam + emit.c + two CLI flags
  (submodule pointer in ai-ezio pins a specific emitter commit, fetchable from origin)
```

### Downstream change surface (keep it tiny)

The change is deliberately minimal and rides stable seams so it survives upstream
churn. It has two parts — an **upstreamable seam** and a **downstream emitter**:

**Upstreamable in shape (kept on the fork; upstreaming optional, not assumed):**
- `src/agent_observer.h` — a general `struct agent_observer` of optional
  agent-loop lifecycle hooks (`on_ready`, `on_user_turn`, `on_assistant_begin`,
  `on_turn_finished`, `on_idle`); mirrors the existing `struct provider` /
  `struct tool` seams. ~5 invocation points in `agent_run`;
- CLI flags `--protocol-fd=<n>` / `--control-fd=<n>` and `--mount-mode` (M4;
  suppress human chrome — banner/usage/resume — for a mounted session);
- **slash-command registration seam** (M4): `slash_register()` in `slash.{c,h}`
  — a general runtime registry so any embedder can add `/`-commands;
- **`HAX_EXTRA_SKILLS_DIR`** (M4): `agent_env.c` enumerates one additional skills
  directory (from the env var) into the model prompt — a general "extra skills
  dir" knob.

**Downstream (ai-ezio's, kept here):**
- `src/protocol/emit.c` (+ header) implementing `agent_observer`, serializing
  JSONL to the protocol fd, and the control reader (`emit_read_control`:
  `submit`/`copy_last_response`/`new_conversation`/`status`; `interrupt` via the
  tick); plus the `on_event` stream hook (deltas/tools/error) and the
  input-source swap;
- `src/protocol/skills_cmd.c` — the downstream `/skills` handler registered via
  the slash seam (lists the honored skill dirs);
- the M4 control integration points in `agent.c` (`new_conversation` →
  `agent_new_conversation`, `status` → `emit_status`) and `meson.build` lines;
- **M7 (mounted REPL parity):** `emit_status` carries an `effort` field;
  `emit_set_usage` stages a turn's token counts that `obs_on_turn_finished`
  attaches to `assistant_turn_finished` (fields omitted when the backend reports
  `-1`, `usage` omitted when empty); `agent.c` auto-emits one `status` right after
  `ready` in `--mount-mode` and stages usage before `on_turn_finished`. Still
  confined to `src/protocol/emit.{c,h}` + a few `agent.c` lines + an engine-level
  test — surfacing data hax already computes (provider/model/effort, per-turn
  usage); a candidate to upstream as part of the observer/emitter seam.
- **M8 (mounted display fidelity):** the emitter now also emits **tool events from
  the `agent.c` dispatch seam** — `emit_tool_started` carries a human-readable
  `args` summary (via a small `tool_display_arg` helper in `agent_dispatch.{c,h}`
  that reads the tool's `display_arg` field), and `emit_tool_finished` carries the
  tool's `output`, an always-boolean `isDiff` (from `tool->output_is_diff`), and an
  **execution-accurate `status`** (`error` on refusal/skip, `ok` on run). These fire
  around the dispatch loop (after `tool->run`), where the result and diff-ness are
  known. The **old stream-hook tool emission** (`EV_TOOL_CALL_START`/`END` cases) and
  its **pending-tool tracking** (`emit_pending_tool`, `EMIT_MAX_PENDING_TOOLS`,
  `pending_tools`/`n_pending_tools`, `pending_tool_add`/`take`) were **removed** —
  net-narrower emit state. Still confined to `src/protocol/emit.{c,h}`, the
  `agent.c` dispatch loop, `agent_dispatch.{c,h}`, and engine-level tests.

> Earlier drafts described this as "one file + 2–3 lines"; the accurate surface
> is the above, and M4/M7/M8 deliberately widened it (mounted mode + the two general
> seams + the usage/effort emitter fields + dispatch-sourced tool events). Anything
> beyond these documented seams is a smell — push it into the TypeScript harness
> instead.

## Sync strategy (hard constraint)

Defined 2026-06-10 after the first full sync exercise. Every future alignment
with upstream MUST follow these rules.

### Cadence

- **Weekly:** rebase `emitter` onto the latest upstream `master` once a week.
  Drift never exceeds a handful of upstream commits, so each sync stays a
  minutes-sized, mechanical job.
- **Exceptionally, before major fork-touching work:** any ezio feature expected
  to change the hax fork at a notable level (touching multiple files) starts
  from a fresh sync, so new downstream commits are never authored against a
  stale base.

### Patch-surface budget (the conflict firewall)

The downstream footprint is exactly the documented change surface above:
wholly-owned files (`src/agent_observer.h`, `src/protocol/`, `tests/protocol/`)
plus thin seam lines in shared files (`agent.c`, `agent_core.{c,h}`,
`agent_dispatch.{c,h}`, `agent_env.c`, `slash.{c,h}`, `main.c`, the two meson
files, `tests/test_slash.c`, `tests/test_agent_dispatch.c`). In the meson files
we own only list entries (`sources`, `test_sources`, `e2e_sources`) and the
small e2e foreach — never structural build logic.

During a sync, a conflict in any file outside this list is a red flag: stop and
redesign the downstream change toward the TS harness instead of widening the
fork. The 2026-06-10 sync confirmed the model: all conflicts fell inside this
list, and the only C-source conflicts were single seam lines.

### Mechanics

```sh
# 1. Trial the rebase in a scratch worktree — the checked-out submodule stays
#    untouched until the result is validated.
git -C vendor/hax fetch hax-upstream
git -C vendor/hax worktree add /tmp/hax-sync -b sync/hax-YYYY-MM-DD emitter
git -C /tmp/hax-sync rebase hax-upstream/master   # resolve only the seam files

# 2. Validate (see the gate below), then publish. A rebase rewrites history:
#    `merge --ff-only` can never fast-forward onto it — move the branch and
#    force-push instead. Park the old tip on an archive branch FIRST: released
#    ai-ezio tags pin old emitter commits, and the archive ref keeps
#    `git submodule update --init` working for every published release.
git -C vendor/hax branch archive/emitter-pre-sync-YYYY-MM-DD emitter
git -C vendor/hax push origin archive/emitter-pre-sync-YYYY-MM-DD
git -C vendor/hax worktree remove /tmp/hax-sync
git -C vendor/hax branch -f emitter sync/hax-YYYY-MM-DD
git -C vendor/hax switch emitter
git -C vendor/hax push --force-with-lease origin emitter

# 3. Bump the submodule pointer in ai-ezio (update the base-commit row in this
#    file in the same commit).
git add vendor/hax UPSTREAM.md
git commit -m "chore: bump hax to <rev> (sync YYYY-MM-DD)"
```

The submodule pointer must always reference a commit pushed to `origin`
(`ai-creed/hax`); otherwise a fresh `git submodule update --init` cannot fetch it.

### Validation gate (all green before the pointer bump)

1. `meson test -C build --print-errorlogs` — full engine suite, including the
   downstream `protocol/` tests.
2. `pnpm -r build && pnpm -r test` — the TS harness against the new engine.
3. `pnpm run smoke:cli-mount` — one real mounted turn end to end.
4. `clang-format --dry-run --Werror` on every C file touched during resolution.

If a major upstream change redesigns the event model itself (the seam the
emitter rides), expect a real, but localized, port — re-anchor `emit.c` to the
new callback shape.

## Merge policy

- **Our hax changes live on the fork** (`ai-creed/hax`, `emitter` branch). We do
  not depend on the original author accepting them. Upstreaming the generic
  `agent_observer` seam is welcome if there's ever interest, but it is optional;
  the fork stands on its own.
- **Rebase the `emitter` branch onto the original repo's `master`** (read-only
  sync source) on the cadence above — weekly, plus exceptionally before major
  fork-touching work — so we keep getting upstream fixes. The patch surface is
  tiny, so conflicts stay confined to the documented seams.
- **ai-creed / ai-whisper-specific behavior** (protocol semantics, mount mode,
  adapter, skills UX): stays downstream in the TypeScript harness, never in hax.
- Prefer small extension seams in hax over rewriting hax core files, so rebases
  onto the sync source stay cheap.

## Downstream-only areas

- `packages/` — all TypeScript harness, protocol client, adapter, CLI.
- `docs/` — ai-ezio design and protocol docs.
- everything except `vendor/hax`.
