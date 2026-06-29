# hax upstream sync (2026-06-29) + compaction reconciliation

**Status:** design approved, pending implementation
**Date:** 2026-06-29
**Scope:** sync the `emitter` hax fork onto upstream `master`, reconcile the
compaction collision (upstream shipped its own compaction), fix the removed
`ollama` provider in the subagent path, verify the M7 effort emitter against
upstream's runtime selection, then validate and publish per `UPSTREAM.md`.

## Background

The vendored hax fork (`vendor/hax`, branch `emitter`) has drifted from upstream.
This is the largest upstream churn since the fork: six upstream feature commits,
~5,989 insertions. The trigger for this sync is a `subagent timed out` diagnosis
that surfaced how stale the base had become, and the recognition that upstream
independently shipped a compaction feature that collides with our M11 compaction.

### Verified current state

- Drift: `emitter` is **behind 6 / ahead 15** of `hax-upstream/master`.
- Merge-base: `de996c1` ("Keep the machine awake while a turn is running"),
  synced 2026-06-15.
- Upstream tip as of this sync: `eebd144` ("Add Anthropic Messages provider").
- The six upstream commits since the base:
  - `eebd144` Add Anthropic Messages provider (real + compatible)
  - `528e58a` Resolve reasoning effort only when the provider accepts it
  - `de0f8f3` Add config-defined custom providers
  - `43f62b7` Add runtime provider, model, and reasoning-effort selection
  - `bcb499b` Compact long conversations into a structured summary
  - `279479c` Show a "composing..." spinner for streaming tool args and tables

### The conflict surface is small textually but hides a real collision

A test-merge of `hax-upstream/master` into `emitter` produces only **3 conflicted
files / 4 hunks**, every one a trivial *additive* "keep both":

- `src/agent_core.h` / `src/agent_core.c`: our M9 `agent_session_add_delegated` /
  `agent_session_is_delegated` next to upstream's new `agent_session_reconfigure`.
- `src/agent.c`: our `#include "agent_observer.h"` next to upstream's
  `#include "compact.h"`; our `last_assistant_text` helper next to upstream's
  `compact_ev` / `compact_on_event`.

Every conflicting file is **inside the documented patch-surface firewall** in
`UPSTREAM.md` — no red-flag conflicts outside the seam. Per the firewall doctrine
this is a sanctioned localized port, not fork-widening.

The textual cleanliness is a trap. Both sides independently define `agent_compact`
in `agent.c` (and declare it in `agent.h`) with **incompatible signatures**:

| | ours (M11) | upstream |
|---|---|---|
| decl | `agent.h:51` | `agent.h:86` |
| def | `agent.c:614` | `agent.c:1054` |
| signature | `void agent_compact(st, summary, keep_k, drop_d, out_dropped, out_kept)` | `int agent_compact(st, instructions, is_auto)` |
| summary | host-supplied via the `compact` protocol control (cortex-enriched) | engine-generated (streams a structured summary from the model) |
| trigger | the TS harness owns it | in-engine auto-threshold (`compact_should_auto`) |

Because the two definitions sit at different line ranges, git keeps both with no
conflict marker — producing a **duplicate-definition compile error** that no merge
tooling flags. This is the real reconciliation work.

### Two compaction philosophies

- **Upstream** (`src/compact.c` / `compact.h`, new, +258/+104): hax generates the
  summary itself by streaming a structured-checkpoint prompt to the model
  (`compact_summarize` → `compact_apply`), auto-triggered from an in-engine
  threshold. Two triggers exist, and the first is **mid-turn**:
  - `agent.c:~1533` — "Mid-task auto-compaction", *inside the tool loop*, between
    round-trips of a single user turn.
  - `agent.c:~1579` — end-of-user-turn, between turns.
  - Gated by `compact.auto`, env-backed as **`HAX_COMPACT_AUTO`** (default `"1"`,
    `config.c:60`). `agent_compact` rewrites `s->items` and rotates the session /
    transcript logs, and makes an extra model round-trip — all with **zero
    protocol emission** (it uses a local `compact_on_event`, not our observer /
    emitter).
- **Ours** (M11): the TS harness owns compaction. It decides *when* (its own
  threshold), supplies a cortex-enriched *summary*, and pushes it via the
  `compact` protocol control. Our `compact` control is dispatched **between turns
  only** — it is handled in the control-pump loop (`agent.c:1000`) that runs
  before a `SUBMIT` breaks out to execute a turn. While a turn runs, the agent
  thread is not reading controls, so the harness physically cannot inject a
  `compact` mid-turn.

If upstream's auto-compaction were left enabled for an ezio-driven session it
would rewrite history mid-turn with no protocol signal, desyncing the harness's
transcript/token model and risking a double-compaction index mismatch when the
harness later sends its own `compact` control. This is why engine auto-compaction
must be disabled for the main mounted session.

## Goals

- Sync the `emitter` fork onto upstream `master` (gain the Anthropic Messages
  provider, config-defined custom providers, runtime provider/model/effort
  selection, the streaming spinner, and upstream's compaction — the last
  benefiting *standalone* hax).
- Resolve the duplicate-`agent_compact` symbol cleanly without widening the fork.
- Preserve harness-owned, cortex-enriched compaction for the main session, and
  prevent silent engine compaction from desyncing the harness.
- Preserve subagent overflow protection.
- Fix the `ollama` subagent profile (upstream removed `ollama.c`).
- Keep every conflict inside the documented patch-surface firewall.

## Non-goals

- Not adopting upstream's engine-generated summary for the *main* session — we
  keep the host-supplied, cortex-enriched summary.
- Not building the signaled mid-turn backstop (see Deferred work).
- Not touching upstream's `compact.c`, provider files, or `select.c` beyond what
  the rebase mechanically requires; no reformatting hax to the TS style.

## Compaction ownership model (after the sync)

Two hax session types, two regimes:

| | **Main mounted session** | **Subagent child session** |
|---|---|---|
| hax engine auto-compact | **OFF** — `HAX_COMPACT_AUTO=0` via `haxSpawnEnv` | **ON** — `profileEnv` pins `HAX_COMPACT_AUTO=1` |
| Driver | the **harness**, via the `compact` protocol control, **between turns** | **hax itself** (upstream `compact.c`, mid-task + end-of-turn) |
| Summary source | host-supplied / **cortex-enriched** | engine-generated (model stream) |
| Applied by | renamed `agent_compact_hosted` → `agent_session_compact` (drop/keep window + summary swap), signaled by the `compacted` event | `compact_apply` (internal) |
| Why this regime | avoid silent mid-turn rewrite desync; keep compaction intelligence in TS | the parent cannot compact a child; small-context models need self-protection; silent is safe (no protocol observer on the child) |

Upstream's `compact.c` rides in **untouched** — standalone hax keeps full auto +
`/compact`. Our only engine change is the rename.

The main session retains a residual: no mid-turn net for a single pathological
turn (a long autonomous tool chain that overflows within one turn). This equals
ezio's pre-sync behavior, is recoverable via error + retry, and closing it is the
explicitly-deferred backstop below.

## Concrete changes

### A. Engine (`vendor/hax`, `emitter` branch) — rebase + one rename

Rebase `emitter` onto `hax-upstream/master` in a scratch worktree per
`UPSTREAM.md` §Mechanics. Resolve the additive conflicts — all "keep both":

- `agent_core.h` / `agent_core.c`: keep our M9 `agent_session_add_delegated` /
  `agent_session_is_delegated` **and** upstream's `agent_session_reconfigure`.
- `agent.c`: keep both includes; keep both helper blocks (our
  `last_assistant_text` and upstream's `compact_ev` / `compact_on_event`);
  preserve the shared `agent_run` signature.

The rename resolves the duplicate `agent_compact` symbol. Rename **our** three
sites only; upstream keeps the name:

- `agent.h:51` declaration → `agent_compact_hosted`
- `agent.c:614` definition → `agent_compact_hosted`
- `agent.c:1016` call site (the `EMIT_CTL_COMPACT` branch) → `agent_compact_hosted`

Upstream's `compact.c` and its `agent_compact(st, instructions, is_auto)` are left
untouched. The name `agent_compact_hosted` denotes the host-supplied-summary path.

### B. Harness (TypeScript) — compaction scoping + ollama

- **`packages/harness/src/spawn.ts` → `haxSpawnEnv`:** set
  `env.HAX_COMPACT_AUTO = "0"`. This is scoped to the main mounted child and is
  never written to `process.env`, so it cannot leak into the subagent's
  `parentEnv`.
- **`packages/subagent/src/profile-env.ts` → `profileEnv`:** set
  `env.HAX_COMPACT_AUTO = "1"` (mirroring the existing effort set-or-clear at
  lines 17–18). This pins subagent self-protection even when a disabling value is
  present in `parentEnv`.
- **ollama cleanup:** upstream removed `ollama.c`. Update the local-model example
  away from the removed `provider: "ollama"` to the supported path (a
  config-defined custom provider / openai-compat) in both the `config.ts` doc
  comment and the `config.test.ts` fixture (`local: { provider: "ollama", model:
  "qwen3:8b" }`). Add a clear dispatch-time error when a profile names a provider
  hax does not know, so a stale `ollama` config fails loudly rather than
  cryptically. The exact replacement provider syntax is pinned during
  implementation, once the new provider registry is in-tree.

### C. M7 effort verify (likely a no-op plus a test)

Upstream's `agent_session_reconfigure` mutates `s->reasoning_effort` on a runtime
`/provider` / `/model` switch. Our `emit_status` (`agent.c:973`) already reads the
live `sess.reasoning_effort`. Confirm post-rebase that `status` and
`assistant_turn_finished` still read the live field, and add or keep an
engine-level test asserting a reconfigure changes the emitted effort.

### File-count note

The change spans roughly ten files across C, TypeScript, and docs. The
implementation plan sequences it into small, independently-green steps (the same
commit-split discipline used for the subagent timeout fix), not one large change.

## Testing strategy (test-first per layer)

### Harness (vitest)

- `spawn.test.ts`: assert `haxSpawnEnv(base)` carries `HAX_COMPACT_AUTO=0`;
  existing assertions still hold.
- `profile-env.test.ts`: assert `profileEnv` returns `HAX_COMPACT_AUTO=1` **even
  when `parentEnv.HAX_COMPACT_AUTO=0`** (the leak-prevention case) and when the
  parent is unset.
- `config.test.ts`: the ollama fixture is updated to the supported provider path
  and parses clean.
- subagent dispatch: an unknown-provider profile yields a clear, loud error.

### Engine (meson)

- A clean compile is the duplicate-symbol proof (the build is the test).
- Existing `tests/protocol/test_compact.c` and `test_compact_e2e.c` stay green via
  the renamed `agent_compact_hosted` path (update any direct symbol reference).
- M7: an engine test asserting a runtime reconfigure changes the emitted effort.
- We do not re-test upstream's `compact_should_auto` env-gating — that is
  upstream's own coverage; our half is the `spawn.test` assertion.

### Edge cases covered by tests

1. Duplicate symbol gone — clean compile.
2. The `compact` control still drives `agent_compact_hosted` — `test_compact*`
   green.
3. Main session env carries `HAX_COMPACT_AUTO=0`.
4. Subagent pins `HAX_COMPACT_AUTO=1` despite a disabling parent env.
5. A runtime `/model` switch reflects in the emitted effort.
6. A stale `ollama` profile fails with a clear error.
7. Manual `/compact` in mount-mode does not reach hax's silent slash path — verify
   the mounted REPL does not forward `/`-input raw into hax's slash registry; if
   it does, add suppression/mapping (small TS change).

## Validation gate (all green before the pointer bump)

Per `UPSTREAM.md`:

1. `meson test -C vendor/hax/build --print-errorlogs` — full engine suite,
   including the downstream `tests/protocol/` tests.
2. `pnpm -r build && pnpm -r test` — the TS harness against the new engine.
3. `pnpm run smoke:cli-mount` — one real mounted turn end to end.
4. `clang-format --dry-run --Werror` on every C file touched during resolution.

## Publish mechanics (separately gated — only after the gate is green)

The rebase / resolve / rename / test work happens in the scratch worktree first.
Nothing in `vendor/hax`'s tracked branches or the submodule pointer moves until
this step, which waits for an explicit go. Per `UPSTREAM.md` §Mechanics, dated
2026-06-29:

1. Archive the old tip: `git -C vendor/hax branch
   archive/emitter-pre-sync-2026-06-29 emitter` and push to `origin` (keeps
   released ai-ezio tags' submodule pointers fetchable).
2. Move and force-push: `emitter` → `sync/hax-2026-06-29`, then
   `push --force-with-lease origin emitter`.
3. Bump the ai-ezio submodule pointer **and** update the `UPSTREAM.md` base-commit
   row (`de996c1` → the post-rebase emitter rev, dated 2026-06-29) in one commit.

## Deferred / future work — signaled mid-turn backstop

The main session has no mid-turn overflow net (status quo). If that ever bites,
the follow-up is to keep hax auto-compaction *on* for the main session too, but
add a small C seam so upstream's `compact_apply` emits our `compacted` event — a
*signaled* backstop, no desync, closing the mid-turn gap. This widens the fork
surface, so it is deferred unless real overflow is observed.

## Risk / firewall verdict

All conflicts fall inside the documented patch-surface firewall, so the model
holds: this is a localized port, not a fork-widening. The principal risks are
(1) missing the duplicate-symbol clash (mitigated: it is the central, explicit
task), and (2) the manual-`/compact`-in-mount-mode edge case (mitigated: a
verify step plus a fallback suppression).
