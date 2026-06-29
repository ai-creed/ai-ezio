# hax upstream sync (2026-06-29) + compaction reconciliation

**Status:** design approved, revised after two phase-gate reviews (2026-06-29)
**Date:** 2026-06-29
**Scope:** sync the `emitter` hax fork onto upstream `master`, reconcile the
compaction collision (upstream shipped its own compaction), verify the subagent
provider path under upstream's reworked provider registry (no migration expected
— `ollama` is now a built-in recipe, not removed), verify the M7 effort emitter
against upstream's runtime selection, then validate and publish per `UPSTREAM.md`.

## Revision note (post-review)

Phase-gate reviews corrected the following design issues, all fixed below:

1. **Compaction env scoping.** The main session and subagent children both spawn
   hax through the shared `spawnHax` → `haxSpawnEnv`, so an unconditional
   `HAX_COMPACT_AUTO=0` in `haxSpawnEnv` would clobber the subagent's intended
   `=1`. The design makes engine-auto-compaction ownership explicit per spawn
   (see "Compaction env scoping").
2. **ollama is not removed.** Upstream removed the dedicated `src/providers/
   ollama.c` but kept `ollama` as a first-class built-in config-provider recipe.
   `provider: "ollama"` still resolves; the earlier "migrate / fail loudly"
   direction is dropped in favor of a verification (see "Subagent provider
   resolution").
3. **Main-session leak guard must be structural, not per-call-site.** The first
   revision routed each main `session.start` / resume call through a
   `mountedEngineEnv` helper, but a unit test on the helper alone could pass while
   a call site (fresh `start`, `startWithTranscript`, or `resume`) silently
   skipped it. The guard is now enforced inside the harness `Session` at its
   single spawn chokepoint (`spawnAndPump`, shared by `start()` and `resume()`),
   so every main spawn is force-off by construction (see "Compaction env
   scoping").

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

If upstream's auto-compaction were left enabled for an ezio-driven main session it
would rewrite history mid-turn with no protocol signal, desyncing the harness's
transcript/token model and risking a double-compaction index mismatch when the
harness later sends its own `compact` control. This is why engine auto-compaction
must be off for the main mounted session — but on for subagent children, which the
parent cannot compact (see "Compaction ownership model").

## Goals

- Sync the `emitter` fork onto upstream `master` (gain the Anthropic Messages
  provider, config-defined custom providers, runtime provider/model/effort
  selection, the streaming spinner, and upstream's compaction — the last
  benefiting *standalone* hax).
- Resolve the duplicate-`agent_compact` symbol cleanly without widening the fork.
- Preserve harness-owned, cortex-enriched compaction for the main session, and
  prevent silent engine compaction from desyncing the harness.
- Preserve subagent overflow protection (engine auto-compaction on for children).
- Confirm the subagent provider path still resolves under upstream's reworked
  provider registry (the seeded `codex` profiles and the local `ollama` recipe);
  no migration expected.
- Keep every conflict inside the documented patch-surface firewall.

## Non-goals

- Not adopting upstream's engine-generated summary for the *main* session — we
  keep the host-supplied, cortex-enriched summary.
- Not building the signaled mid-turn backstop (see Deferred work).
- Not touching upstream's `compact.c`, provider files, or `select.c` beyond what
  the rebase mechanically requires; no reformatting hax to the TS style.
- Not treating `provider: "ollama"` as stale/unknown — upstream intentionally
  keeps it as a built-in recipe.

## Compaction ownership model (after the sync)

Two hax session types, two regimes:

| | **Main mounted session** | **Subagent child session** |
|---|---|---|
| hax engine auto-compact | **OFF** — the main `Session` is constructed with `engineEnvOverrides: { HAX_COMPACT_AUTO: "0" }`, force-applied in `spawnAndPump`; the shared `haxSpawnEnv` only off-defaults when the key is unset and never overrides an explicit value | **ON** — `profileEnv` force-sets `HAX_COMPACT_AUTO=1` |
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

### B. Harness (TypeScript) — compaction env scoping

Engine auto-compaction is owned **per spawn**; the shared wrapper never overrides
an explicit value. Both the main mounted session and subagent children spawn hax
through `spawnHax` → `haxSpawnEnv` (`packages/harness/src/spawn.ts:55`), and the
subagent child is itself a harness `Session` started with `profileEnv(...)`
(`packages/subagent/src/dispatch.ts:111` → `packages/harness/src/session.ts:271`).
So an unconditional `HAX_COMPACT_AUTO=0` in `haxSpawnEnv` would clobber the
subagent's intended `=1`. The design resolves this with explicit precedence and a
**structural** main-session guard:

- **`packages/harness/src/spawn.ts` → `haxSpawnEnv`:** supply an **off default
  only when the key is unset**, and **never override an explicit value**
  (`if (env.HAX_COMPACT_AUTO == null) env.HAX_COMPACT_AUTO = "0"`). This defaults
  any mounted spawn to off while leaving a caller's explicit `=1` intact.
- **`packages/harness/src/session.ts` → new `SessionOptions.engineEnvOverrides?:
  NodeJS.ProcessEnv`:** a generic map of engine env keys the `Session` force-sets
  onto **every** child spawn. It is applied in the single internal spawn chokepoint
  `spawnAndPump` — which both `start()` and `resume()` route through — by merging
  the overrides last over `options.env ?? process.env`. This guarantees the values
  survive every start/resume path of that session by construction. (The harness
  already carries compaction concerns such as `compactTimeoutMs`, so this fits.)
- **Main mounted session (`packages/cli/src/repl/standalone-runtime.ts`):**
  construct the main `Session` once with
  `engineEnvOverrides: { HAX_COMPACT_AUTO: "0" }`. The current call sites — fresh
  `session.start(opts.startOptions ?? {})` (`:119`), `startWithTranscript`'s
  `session.start({ args, transcriptPath })` (`:261`), and `session.resume(id)`
  (`:305`) — then **all** force-off via the constructor, with no per-call-site
  change required and no path able to skip it. Forcing (not defaulting) ensures an
  inherited shell/parent value cannot leak engine auto-compaction into the main
  session.
- **`packages/subagent/src/profile-env.ts` → `profileEnv`:** **force-set**
  `HAX_COMPACT_AUTO=1` (mirroring the effort set-or-clear at lines 17–18), so a
  disabling parent env cannot strip subagent self-protection. The subagent's
  `Session` is constructed **without** `engineEnvOverrides`, so nothing re-forces
  it off.

Precedence is unambiguous: the main `Session` force-sets `0` at its single spawn
chokepoint (covering fresh/one-shot/resume); the subagent's `profileEnv` force-sets
`1`; the shared `haxSpawnEnv` only fills an off default when nothing is set. Result:
main = `0` and subagent = `1` for every inherited-env combination.

**hax config-tier precedence (why the env value is authoritative).** Post-sync hax
resolves every tunable in priority order: session-scoped runtime override
(`config_set_override`, written by `/model`-style slash commands) → environment
(`HAX_COMPACT_AUTO`) → config file (`~/.config/hax/config.json`, `compact.auto`)
→ registry default (`"1"`). Environment therefore **wins over a user's config
file**, so the spawn-env value we set is authoritative; a user's
`~/.config/hax/config.json` cannot re-enable engine auto-compaction on the main
session. The only tier above env is a session-scoped slash-command override, which
is unreachable in ezio's mounted main session (chrome suppressed, harness owns
input) and in subagent children (no interactive REPL).

### B2. Subagent provider resolution (verify; no migration)

Upstream removed the dedicated `src/providers/ollama.c` but **kept `ollama` as a
first-class provider** via a built-in config-provider recipe: `config_provider.c`
defines `RECIPES[] = { .name = "ollama", .base_url =
"http://127.0.0.1:11434/v1", ... }` (openai-completions dialect, keyless local,
reachability-probed), and `registry.c` exposes recipe providers through
`provider_find` / `make_factory`. A subagent profile
`{ provider: "ollama", model: "qwen3:8b" }` therefore **still resolves** after the
sync. The earlier "ollama removed → migrate / fail loudly" premise was wrong and
is dropped. Action (verification, no code change expected):

- Confirm both the seeded `codex` profiles and a local `ollama` profile resolve
  under the reworked registry (upstream's `tests/providers/test_config_provider.c`
  already asserts `provider_find("ollama") != NULL`, a selectable single recipe
  entry, and provider construction; the meson gate runs it).
- Confirm the keyless `ollama` profile still passes `validateProfile` (no
  `apiKeyEnv` required) and that `config.ts` / `config.test.ts` keep
  `provider: "ollama"` as a valid example.
- Do **not** add ezio-side "unknown provider" rejection targeting `ollama`; hax
  already errors on a genuinely unknown provider name.

### C. M7 effort verify (likely a no-op plus a test)

Upstream's `agent_session_reconfigure` mutates `s->reasoning_effort` on a runtime
`/provider` / `/model` switch. Our `emit_status` (`agent.c:973`) already reads the
live `sess.reasoning_effort`. Confirm post-rebase that `status` and
`assistant_turn_finished` still read the live field, and add or keep an
engine-level test asserting a reconfigure changes the emitted effort.

### File-count note

The change spans roughly a dozen files across C, TypeScript, and docs (the harness
touch now includes `session.ts` for `engineEnvOverrides`). The implementation plan
sequences it into small, independently-green steps (the same commit-split
discipline used for the subagent timeout fix), not one large change.

## Testing strategy (test-first per layer)

### Harness (vitest)

- `spawn.test.ts`: assert `haxSpawnEnv` **preserves an explicit
  `HAX_COMPACT_AUTO`** (e.g. `=1` in → `=1` out) and **off-defaults to `0` only
  when the key is unset** — proving the shared wrapper does not clobber a
  subagent's `=1`.
- `session.test.ts` (per real start/resume path, via the `spawn` test seam): a
  `Session` constructed with `engineEnvOverrides: { HAX_COMPACT_AUTO: "0" }` and a
  base/`process.env` carrying `HAX_COMPACT_AUTO=1` must hand the engine spawn an
  env with `HAX_COMPACT_AUTO=0` on **each** path:
  - fresh `start({})`,
  - one-shot-shaped `start({ args, transcriptPath })` (the `startWithTranscript`
    call shape),
  - `resume(id)`.
  And the **negative/subagent** case: a `Session` constructed **without**
  `engineEnvOverrides`, started with env `{ HAX_COMPACT_AUTO: "1" }` (the
  `profileEnv` shape), hands the spawn `=1` (not clobbered).
- standalone-runtime wiring test: the production main `Session` is constructed with
  `engineEnvOverrides` containing `HAX_COMPACT_AUTO=0` — so the structural guard is
  actually wired, not just available.
- `profile-env.test.ts`: assert `profileEnv` force-sets `HAX_COMPACT_AUTO=1`
  **even when `parentEnv.HAX_COMPACT_AUTO=0`** (the leak-prevention case) and when
  the parent is unset.
- subagent provider resolution: a seeded `codex` profile and a local
  `{ provider: "ollama", model: "qwen3:8b" }` profile both validate; the keyless
  `ollama` profile passes `validateProfile`.

### Engine (meson)

- A clean compile is the duplicate-symbol proof (the build is the test).
- Existing `tests/protocol/test_compact.c` and `test_compact_e2e.c` stay green via
  the renamed `agent_compact_hosted` path (update any direct symbol reference).
- M7: an engine test asserting a runtime reconfigure changes the emitted effort.
- We do not re-test upstream's `compact_should_auto` env-gating — that is
  upstream's own coverage; our half is the harness env tests above.

### Edge cases covered by tests

1. Duplicate symbol gone — clean compile.
2. The `compact` control still drives `agent_compact_hosted` — `test_compact*`
   green.
3. **Every** main start/resume path force-offs: the main `Session`
   (`engineEnvOverrides: { HAX_COMPACT_AUTO: "0" }`) hands the spawn `=0` from
   `start({})`, `start({ args, transcriptPath })`, and `resume(id)` even when the
   base env has `=1` — exercised against the real `Session` code via the `spawn`
   seam, not a helper in isolation.
4. The production main `Session` is constructed with the `HAX_COMPACT_AUTO=0`
   override (wiring is present, so no path can silently skip it).
5. `haxSpawnEnv` preserves an explicit `HAX_COMPACT_AUTO` and off-defaults only
   when unset — a subagent's `=1` survives the shared wrapper.
6. `profileEnv` force-sets `HAX_COMPACT_AUTO=1` despite a disabling parent env; a
   `Session` without `engineEnvOverrides` does not re-force it off.
7. A runtime `/model` switch reflects in the emitted effort.
8. Subagent provider resolution: seeded `codex` and local `ollama` profiles both
   validate/resolve under the reworked registry; keyless `ollama` passes
   `validateProfile`.
9. Manual `/compact` in mount-mode does not reach hax's silent slash path — verify
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
task), (2) a main-session start/resume path leaving engine auto-compaction on
(mitigated **structurally**: the force-off is applied inside `Session.spawnAndPump`
— the single chokepoint both `start()` and `resume()` share — via the constructor
`engineEnvOverrides`, and verified per real path through the `spawn` seam plus a
wiring test, so no call site can skip it), and (3) the manual-`/compact`-in-mount-
mode edge case (mitigated: a verify step plus a fallback suppression).
