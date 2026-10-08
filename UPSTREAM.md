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
| Base commit          | `2834c2c` (upstream master as of 2026-10-07; emitter tip `05729b9`; synced 2026-10-08 — catch-up complete; original derivation `8fd139b`, 2026-05-29) |

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
  dir" knob. Since v0.5.0 it sits in `append_skills` beside upstream's own
  roots (nearest-first project walk, `$XDG_CONFIG_HOME/hax/skills`,
  `~/.agents/skills`); the downstream `/skills` lister in
  `src/protocol/skills_cmd.c` still enumerates its own three dirs.
- **`--list-sessions`** (ezio REPL resume): a non-interactive subcommand that
  prints the cwd's saved sessions as a JSON array — `session_list_json()` in
  `session.c` (a self-contained, append-only function reusing the existing
  `session_list` / `session_first_prompt`), printed and exited early in `main.c`
  before any provider work. Since the v0.4.0 sync the flag (and the three
  protocol/mount flags) are parsed in upstream's `cli.c` / `cli.h`, where all
  option parsing now lives — `main.c` only keeps the early exit.
- **`tool_def.parameters_schema_json`** (v0.4.0 sync): upstream replaced the
  tool-schema string with a typed `tool_param` array serialized by
  `tool_schema.c`. Host-delegated (MCP) tools arrive with arbitrary JSON
  Schemas, so `provider.h` gains one optional field and `tool_schema_build`
  one early branch that passes a verbatim schema through. NULL for every
  native tool; generic enough to upstream. A generic host-facing seam so an embedder (ai-ezio)
  can render its own resume picker without re-deriving hax's private on-disk
  session layout.

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
- **agent_loop hooks (v0.4.0 sync):** upstream extracted the inner turn loop
  into `agent_loop.c`, driven by `struct agent_loop_hooks`. The emitter now
  rides those hooks from `agent.c`'s `repl_loop_*` adapters instead of an
  inlined loop: `observe` mirrors stream events, `tick` polls the protocol
  `interrupt`, `checkpoint` turns it into an abort, `turn_begin` fires
  `assistant_turn_started` per round-trip, `turn_end` stages M7 usage, and
  `tool_call` wraps M8 tool events around dispatch and hosts the M9 delegated
  branch (`dispatch_delegated_call`). Boundaries, log flushing and abort repair
  are upstream's job now — the downstream `agent.c` footprint shrank. `isDiff`
  comes from `tool_output_is_diff()` in `agent_dispatch.c` (upstream dropped
  the `output_is_diff` flag). Upstream later removed the loop's `turn_end`
  hook and derives all stats from the record (`agent_stats`), so the M7
  `assistant_turn_finished.usage` is derived the same way:
  `turn_usage_from_record()` sums this turn's `TURN_USAGE` footers (output
  summed, cached from the last footer, compaction footers skipped);
- **M7 (mounted REPL parity):** `emit_status` carries an `effort` field;
  `emit_set_usage` stages a turn's token counts that `obs_on_turn_finished`
  attaches to `assistant_turn_finished` (fields omitted when the backend reports
  `-1`, `usage` omitted when empty); `agent.c` auto-emits one `status` right after
  `ready` in `--mount-mode` and stages usage before `on_turn_finished`. Still
  confined to `src/protocol/emit.{c,h}` + a few `agent.c` lines + an engine-level
  test — surfacing data hax already computes (provider/model/effort, per-turn
  usage); a candidate to upstream as part of the observer/emitter seam.
- **M11 (compaction):** `agent_session_compact` (drop window + keep window +
  summary swap, `agent_core.{c,h}`), the `compact` control / `compacted` event
  (parse-time validation + turn-less error, `emit.{c,h}`), and the
  `agent_compact_hosted` handler + transcript/session-log rotate-and-re-seed
  in `agent.{c,h}` — still confined to the documented seam files; tests in
  `tests/protocol/`.
  **Deferred (2026-10-08 sync):** upstream's session files are append-only now
  ("never shrink"; /undo appends an undo record and retires items, compaction
  appends a `COMPACT_SEED` user message and `agent_session_context` serves
  only what follows the newest seed, /session spend is derived from the
  record). The hosted compact still rotates to a fresh session file and
  re-seeds it — correct for `--resume`/`--continue` (covered by
  `protocol/compact_e2e`) and within the API (`session_log_reset` serves
  `/new`), but the summarized turns' spend leaves `/session` stats. Revisit:
  express `dropLastTurns` as `agent_session_retire` + `session_log_undo` and
  the summary as an appended compaction seed, so no rotation is needed. The
  `keepLastTurns` window needs a seed placed *before* the kept turns, which
  the append-only file order cannot express today — that is the open design
  question, and the reason this was not done inside the catch-up sync.
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
- **Catch-up after a lapse:** when drift has grown past a release boundary
  (the 2026-10-08 sync was 263 commits / 12 missed weeks behind), stage the
  rebase one upstream tag at a time (`v0.4.0`, then `v0.5.0`, then `master`),
  running the validation gate at each stop, and rebase the downstream change as
  ONE squashed commit (the granular history stays on the archive branch).
  Replaying every downstream commit across a structural upstream refactor
  re-conflicts the same hunks repeatedly.
- **Audit `rerere` resolutions.** `rerere.enabled` is on in the fork. It silently
  "resolved" `main.c` at the 2026-10-08 sync by dropping all four downstream CLI
  flags (upstream had moved parsing to `cli.c`). After any rebase stop, diff
  every rerere-resolved file against the upstream base before trusting it.
- **Before major fork-touching work:** any ezio feature expected to change the
  hax fork at a notable level (touching multiple files) starts from a fresh
  base — but the weekly cadence is the only sync trigger. If the pre-feature
  drift check fires mid-week, the feature is PARKED until the next scheduled
  sync; an early sync is never run for it (owner decision 2026-07-18, after
  the 3a arc hit this gate). AGENTS.md carries the last-sync marker to check
  against.

### Patch-surface budget (the conflict firewall)

The downstream footprint is exactly the documented change surface above:
wholly-owned files (`src/agent_observer.h`, `src/protocol/`, `tests/protocol/`)
plus thin seam lines in shared files (`agent.c`, `agent_core.{c,h}`,
`agent_dispatch.{c,h}`, `agent_env.c`, `session.{c,h}`, `slash.{c,h}`, `main.c`,
`cli.{c,h}`, `provider.h`, `tool_schema.c`, the two meson files,
`tests/test_slash.c`, `tests/test_agent_dispatch.c`, `tests/test_session.c`).
`cli.{c,h}`, `provider.h` and `tool_schema.c` joined the list at the v0.4.0
sync (2026-10-08) when upstream moved option parsing and the tool-schema model.
In `tests/meson.build` the downstream e2e executables link `test_support_dep`
(the compiled test harness) and run under `test_env`, mirroring upstream's own
unit-test block — keep that block in step when upstream changes it. The `session.{c,h}` footprint is one append-only
function (`session_list_json`) plus its declaration — additive, so a rebase sees
no overlap with existing session logic. In the meson files we own only list
entries (`sources`, `test_sources`, `e2e_sources`) and the small e2e foreach —
never structural build logic. (The former `hax_commit` git lookup + `c_args`
block is gone since 2026-10-08: the `ready` event's `haxBaseCommit` now carries
upstream's `HAX_VERSION` from the generated `version.h`, so builds without git —
upstream's Alpine/Arch/Debian/BSD CI containers — configure cleanly.)

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
   downstream `protocol/` tests. Known upstream flakes under the full parallel
   run (as of 2834c2c): `system/browser` and `system/git` wait on detached
   helpers with a bounded window and fail on pristine upstream too; rerun them
   in isolation before blaming the sync.
2. `pnpm -r build && pnpm -r test` — the TS harness against the new engine.
3. `pnpm run smoke:cli-mount` and `pnpm run smoke:proto` — one real mounted
   turn and the protocol lifecycle/interrupt path. Both scripts hardcode
   `vendor/hax/build/hax`; while the sync is still in the scratch worktree,
   run copies pointed at the worktree's build or they test the OLD binary.
4. **Standalone human REPL:** `scripts/repl-regression.py <pristine-upstream-hax>
   <synced-hax>` — the no-fd interactive path must stay byte-for-byte identical
   to a pristine build of the same upstream tag (build one in a detached
   worktree). Plus `ai-ezio -p` and `ai-ezio doctor` through
   `packages/cli/bin/ai-ezio.mjs` with `AI_EZIO_HAX_BIN` set.
5. **Whisper collab mode:** in the sibling ai-whisper repo, `e2e:ai-ezio-mount`
   (real `whisper collab mount ezio`, relay handoff, M8 tool + table rendering)
   and `e2e:ai-ezio-workflow` (full SDD run, ezio implementer + claude
   reviewer). Same hardcoded-path caveat as step 3.
6. `make lint` in `vendor/hax` — upstream's full gate: clang-format, the
   `scripts/lint_style.py` conventions, and clang-tidy (needs Homebrew llvm:
   `scripts/install_deps.sh lint`). Upstream's CI matrix runs it on every push
   to the fork, so the downstream files must satisfy it: quote-includes are
   plain paths under `src/` or `tests/` (never `../`), include lines carry no
   comments, block-comment delimiters sit beside text, tests use `t_tempdir()`
   instead of raw `mkdtemp`, every header a file uses is included directly.
7. `BUILD_DIR=build-asan make tests` and `BUILD_DIR=build-tsan scripts/check.sh
   test protocol/...` — the same matrix runs ASAN/UBSAN/TSAN; every
   `emit_state_init` in a test needs its `emit_state_free`, and e2e drains must
   wait for EOF, not a fixed quiet window (sanitized exits are slow).
   (Kept as the quick per-file check; step 6 supersedes it.)
   Feed the file list through `xargs` (or `${=files}` in zsh): zsh does not
   word-split an unquoted `$files`, so `clang-format $files` sees ONE bogus
   newline-joined path, prints "No such file" and checks nothing. Stage 1 of
   the 2026-10-08 sync shipped 18 violations exactly this way; stage 2 fixed
   them. Treat a gate whose output you did not read as a gate that did not run.

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
