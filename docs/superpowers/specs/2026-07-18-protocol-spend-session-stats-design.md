# Protocol arc 3a — session spend + `/session` stats

**Date**: 2026-07-18 · **Arc**: UX-hardening slice 3, spend cluster (parity
audit items B1b + B2; `2026-07-15-hax-ux-parity-audit.md`). The selection
cluster (D2 + E1) is a separate later spec (3b).

## Context

The 2026-07-15 engine sync brought upstream's per-request cost accounting:
`struct stream_usage` now carries 6 fields (added `cache_write_tokens`,
`cache_write_1h_tokens`, `cost`), `turn_usage_make` resolves per-turn USD
(exact provider charge or `~` catalog estimate), and `struct session_stats`
(vendor/hax/src/agent.h) accumulates per-sitting totals — turns, requests,
tool calls, worked time, spend (`spend_total(&stats.spend, &approx)` prices
lazily at read). None of it crosses the protocol: `assistant_turn_finished.
usage` ships only `contextTokens/outputTokens/cachedTokens/contextLimit`.

This spec extends the protocol with two small, documented seams (the
approach the owner selected: per-turn fields for the always-on display, a
control round-trip for the on-demand command) and renders both.

## Goals

1. Stats line gains the session's running spend as its widest-scope item:
   `42s · 8.9k / 256k (3%) · $0.042` (`~$` when any component is
   estimated). Implemented once in the shared renderer; the standalone
   surface ships it in this arc, and the mounted surface picks it up when
   the adapter rebuilds against this release (no adapter code change; its
   acceptance evidence rides the follow-up named in Non-goals).
2. `/session` slash command, engine-backed (user turns, requests, tool
   calls, token totals, worked time, spend), implemented in the shared
   surface package and wired on the standalone surface in this arc. The
   mounted surface gains it via the tracked adapter follow-up (Non-goals);
   the capability seam is designed here so that wiring is one line.
3. `/usage` shows the richer per-turn payload (cache-write tokens, turn
   cost) when present.

## Non-goals

- Selection controls / pickers / banner-reprint (spec 3b).
- Per-tool-type breakdown in `/session` (engine caps at 8 slots; total
  suffices) and per-category cost decomposition (transcript footers and
  engine-side `/usage` already carry it).
- Historical totals across `/resume` — upstream's `session_stats` is
  per-sitting by design (`/new` zeroes it, `/resume` does not restore);
  the protocol mirrors that semantic exactly.
- ai-whisper adapter wiring (downstream repo) — a tracked follow-up with
  defined content, not an implied one: pass `sessionStats: () =>
  session.sessionStats()` into the adapter's `SlashContext` and capture
  the mounted acceptance evidence (a real-provider turn through
  `whisper collab mount ezio` showing the spend-bearing stats line and a
  non-empty `/session`). Until it lands, mounted `/session` prints the
  designed `session stats unavailable` fallback — a defined state, not a
  gap.
- Protocol version bump: both changes are additive-optional, consistent
  with M7/M8/M11; `AI_EZIO_PROTOCOL_VERSION` stays `0.1.0`.

## §1 Protocol: per-turn usage fields

`assistant_turn_finished` fires once per **user turn**, but a tool-using
turn makes several model round-trips and usage arrives per round-trip
(`turn_usage_make` is per-request). The M7 fields already aggregate
(`outputTokens` sums across round-trips, `cachedTokens` is last-round);
the six new fields get an explicit per-user-turn aggregation the same way
(table below).

**Turn frame.** The per-turn fields cover the user turn's *conversational*
round-trips — the prompt and its tool loop. Compaction requests are
deliberately excluded, including engine auto-compaction, which runs inside
the user turn just before `assistant_turn_finished` (reachable in shipped
subagent sessions via `HAX_COMPACT_AUTO=1`): `compact_on_event` accounts
into `struct session_stats` only, the existing M7 fields already exclude
it, and upstream's own `worked_ms` accrues before the in-turn auto-compact
runs — the engine consistently treats compaction as session overhead, not
turn work. So a compaction round-trip never contributes to `costTotal` /
`cacheWriteTokens` / `cacheWrite1hTokens`, while `sessionSpend` — read at
the staging point, which sits *after* the in-turn auto-compact — does
include it (as do the `session_stats` totals and `requests` counter). This
also keeps attribution mode-invariant: harness-driven compaction (the M11
TS auto-compact driver) runs between turns, where no per-turn frame exists
at all, and both compaction paths land identically in the session figures.

| Field | Type | Per-user-turn value |
| --- | --- | --- |
| `cacheWriteTokens?` | number | sum of `stream_usage.cache_write_tokens` over round-trips that reported it |
| `cacheWrite1hTokens?` | number | sum of `stream_usage.cache_write_1h_tokens` over round-trips that reported it |
| `costTotal?` | number (USD) | this user turn's spend: a turn-local `struct spend_totals` fed by `spend_account()` per round-trip, read with `spend_total()` at turn end |
| `costEstimated?` | boolean | that `spend_total()` call's `approx`; only beside `costTotal` |
| `sessionSpend?` | number (USD) | `agent_session_spend(&stats, &approx)` read at turn end, after every round-trip is accounted |
| `sessionSpendEstimated?` | boolean | that call's `approx`; only beside `sessionSpend` |

Reusing `spend_account`/`spend_total` for the turn cost keeps the engine's
single definition of the reported-vs-estimated split
(vendor/hax/src/agent_core.c): a round-trip with an exact provider charge
(including an explicit `$0`) adds to the reported sum; one with tokens but
no charge becomes a record priced lazily against the catalog at read; a
mixed turn therefore prices to exact + estimate with `approx = 1` (any
record at all makes the figure inexact — upstream's rule); an unpriceable
record (no catalog identity, model unknown to the catalog) contributes
nothing and still sets `approx = 1`.

Presence rules: the two token fields follow M7 discipline — absent until
some round-trip reports them (`-1` seed), a reported zero then shows as
`0`; an empty `usage` object is omitted entirely; booleans appear only
beside their value field. The cost/spend fields instead use upstream's own
display gate: present iff the figure is `> 0`, the same `spend > 0` rule
the engine's stats line and `/session` apply (agent_core.c, slash.c). An
explicit all-$0.00 free-tier turn therefore omits them, exactly as
upstream renders nothing for that state.

## §2 Protocol: `session_stats` control + event

Mirrors the `status` round-trip (answered between turns; in mount mode the
harness sends the control over fd 4).

Control (harness → engine): `{"type":"session_stats"}`

Event (engine → harness):

```json
{"type":"session_stats","turns":4,"requests":9,"toolCalls":12,
 "inputTokens":81234,"outputTokens":4321,"cachedTokens":60000,
 "cacheWriteTokens":9000,"workedMs":184000,
 "spend":0.042,"spendEstimated":true}
```

Counters (`turns`, `requests`, `toolCalls`, `workedMs`) are always
present — zero is a real value there. The token fields and `spend` come
from plain accumulators that start at zero and deliberately keep no
"was reported" state (vendor/hax/src/agent.h: "a zero can also mean 'the
backend never said'"), and `spend_total()` returns `0` both for no priced
data and an explicit provider-reported `$0.00` — so a
never-reported-vs-explicit-zero distinction is not implementable from the
engine's data, and upstream does not draw it either. The event therefore
adopts upstream's display gates as the wire rule: each token field is
present iff its accumulator is `> 0`, and `spend` is present iff
`spend_total() > 0` (`spendEstimated` only beside it) — the exact `> 0`
gates `slash_run_session` and the stats line apply. A fresh session thus
answers with counters only, and an all-free-tier session (explicit $0.00
charges) omits `spend`, matching upstream's rendering of the same state.
Semantics are per-sitting (see Non-goals).

Both additions are documented in `docs/protocol.md` in the same commit that
implements them (protocol-is-the-contract).

## §3 Engine (fork) changes — sanctioned seams only

- **Staging** (`src/protocol/emit.{c,h}`): keep `emit_set_usage` as is; add
  `emit_set_turn_costs(struct emit_state *es, const struct emit_turn_costs *tc)`
  taking a small struct (the six §1 values, `-1`/`-1.0` = absent; the
  emitter additionally applies the §1 `> 0` gate to the cost/spend
  fields). Staged values are consumed and cleared by the next
  `assistant_turn_finished` emission, exactly like the M7 fields.
- **Call site** (`src/agent.c`, the user-turn loop): aggregate per
  round-trip beside the existing M7 turn-locals (`user_turn_out` et al.) —
  two cache-write sums (seeded `-1`, add on report) and a turn-local
  `struct spend_totals` fed by the same `spend_account(...)` call the
  session accumulator uses; both run at the existing accounting point,
  which sits before the error/interrupt branches, so a
  truncated-but-billed response counts. At the existing M7 staging point
  (just before `on_turn_finished`), read `spend_total(&turn_spend, ...)`
  and `agent_session_spend(&state.stats, ...)`, fill `emit_turn_costs`,
  then `spend_free(&turn_spend)` (it owns heap records). The staging
  point sits after the in-turn auto-compaction call, so the session
  figures include compaction while the turn-locals — fed only by the
  main-loop accounting point, never by `compact_on_event` — exclude it
  by construction (§1 turn frame). Errored/interrupted user turns stage
  whatever was accounted, matching the M7 fields' current behavior.
- **Mock catalog seam** (`src/providers/mock.c`): `mock_provider_new`
  additionally reads config `mock.catalog_id` (mirroring the existing
  `mock.script` read) and sets `provider->catalog_id` when present. This
  two-line, test-only seam is what makes the estimate path exercisable
  under `HAX_PROVIDER=mock`: with rates supplied through the hermetic
  `catalog.models` config tier (`fill_from_config`,
  vendor/hax/src/catalog.c — no network), a token-only mock response
  prices to a real catalog estimate. Without it the mock has no catalog
  identity, `spend_rec_price()` returns `-1`, and a mixed
  exact-plus-estimate turn cannot be asserted. The mock script already
  supports every other fixture knob needed (`cost=`, `cache_write=`,
  `cache_write_1h=`).
- **Control** (the dispatch that handles `status`/`effort` controls): add
  `session_stats` → handler reads `st->stats`, calls `spend_total`, emits
  via a new `emit_session_stats(...)` in emit.c.
- **Tests** (meson, `HAX_PROVIDER=mock`): extend the usage protocol test
  for single-request presence/omission of the six fields, plus three
  adversarial cases: (a) a **two-request tool turn**, run with
  `mock.catalog_id` set and rates in `catalog.models` — first response
  makes a tool call and reports an exact `cost=`, second reports tokens
  only (`in=`/`out=`/`cache_write=`) — asserting `cacheWriteTokens` sums
  across both requests, `costTotal` equals the exact charge plus the
  config-tier catalog estimate, and `costEstimated` is true for the
  mixed turn, at the real `agent.c` staging layer; (b) an
  **explicit-zero** turn (provider reports `cost=0`) asserting
  `costTotal` and `sessionSpend` are omitted under the `> 0` gate;
  (c) an **auto-compaction** turn (`HAX_COMPACT_AUTO=1` over the
  existing compact protocol-test setup, the compaction response
  reporting usage and a cost) asserting the intentional frame split:
  the finishing turn's `costTotal`/`cacheWriteTokens` exclude the
  compaction request while its `sessionSpend` — and the subsequent
  `session_stats` event's totals and `requests` — include it. New
  `tests/protocol/test_session_stats.c` driving the control: a
  fresh-session case (counters present at zero; token and spend fields
  absent) and an after-a-mock-turn case (accumulated fields present and
  consistent with the per-turn event).
- **Discipline**: run the UPSTREAM.md freshness check before implementation
  (last sync 2026-07-15; the cadence rule requires a pre-feature sync when
  the fork is touched at a notable level); `clang-format -i` on touched C
  files; keep the production-source delta inside the emitter/controls
  patch surface plus the named two-line mock catalog-id seam above — no
  other engine sources (new tests and their meson registration are, of
  course, expected).

## §4 TS harness

- `@ai-ezio/protocol`: type + codec additions for the six usage fields and
  the `session_stats` control/event pair.
- `@ai-ezio/harness` `Session`: `sessionStats(): Promise<SessionStatsEvent>`
  shaped like `status()` — send control, await the matching event; same
  between-turns answering semantics, no new queueing behavior.

## §5 Surfaces

- **Stats line** (`packages/surface/src/mounted-renderer.ts`, `statsLine`):
  append the spend as the third, widest-scope part when the finished turn's
  `usage.sessionSpend` is present: `fmtCost(sessionSpend)` prefixed with
  `~` when `sessionSpendEstimated`. Absent spend → today's line unchanged;
  errored-turn suppression unchanged.
- **`fmtCost`** (new in the surface package): exact TS port of the fork's
  `format_cost` (vendor/hax/src/util.c): `<= 0 → "$0.00"`, `< 0.01 →
  $%.4f`, `< 1.0 → $%.3f`, else `$%.2f`.
- **`/session`** (`packages/surface/src/slash.ts`): new command via
  capability `SlashContext.sessionStats?: () => Promise<SessionStatsEvent>`;
  missing capability prints `session stats unavailable` (the
  `/transcript` pattern). Output rows mirror upstream's `slash_run_session`
  order using data the surface already has plus the event: `provider`
  (provider · model · effort, from the last `status` event), `user turns`,
  `requests`, `tool calls`, token totals, `worked` (`fmtDuration`),
  `spend` (`fmtCost`, `~` when estimated). Rows whose fields are absent
  from the event are dropped, not zero-filled (the event's `> 0` gate
  mirrors upstream's row gating); the `tool calls` row is additionally
  dropped at zero — the event always carries the counter, but upstream's
  renderer gates that row on `> 0` and we match it.
- **`/usage`**: include cache-write tokens and turn cost lines when the
  new fields are present.
- **Wiring**: standalone runtime passes `sessionStats: () =>
  session.sessionStats()` into the slash context. The mounted surface is
  wired by the tracked ai-whisper follow-up (Non-goals); until it lands,
  mounted `/session` prints the `session stats unavailable` fallback by
  design.

## §6 Verification

- **C**: the §3 protocol tests (extended usage cases, including the
  two-request mixed exact-plus-estimate, explicit-zero, and
  auto-compaction frame-split regressions, plus `test_session_stats`)
  green in `meson test`.
- **TS**: codec round-trip tests (including a counters-only fresh-session
  `session_stats` event); `statsLine` spend rendering (present /
  estimated / absent / errored-turn suppression); `fmtCost` threshold
  table matching `format_cost`; `/session` render test (full payload +
  dropped-row case + unavailable fallback); harness `sessionStats()` test
  against a scripted event stream.
- **Acceptance (real engine, this repo — standalone surface)**: one
  real-provider turn whose stats line shows `· $…` (or `· ~$…`), plus a
  tool-using turn (≥ 2 requests) after which `/session` returns non-zero
  turns/requests and a spend consistent with the transcript footers.
  Evidence committed as an artifact per the slice-1 practice. Mounted
  acceptance (the same checks through `whisper collab mount ezio`)
  belongs to the adapter follow-up's brief (Non-goals), not this arc.
