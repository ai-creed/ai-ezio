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
   estimated). Both surfaces, via the shared renderer.
2. `/session` slash command on both surfaces, engine-backed: user turns,
   requests, tool calls, token totals, worked time, spend.
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
- ai-whisper adapter wiring (downstream repo, follow-up as in every slice).
- Protocol version bump: both changes are additive-optional, consistent
  with M7/M8/M11; `AI_EZIO_PROTOCOL_VERSION` stays `0.1.0`.

## §1 Protocol: per-turn usage fields

`assistant_turn_finished.usage` gains six optional fields (M7 omission
discipline: a field the engine reports as `-1` is omitted; an empty `usage`
object is omitted entirely; booleans appear only beside their value field):

| Field | Type | Source (engine) |
| --- | --- | --- |
| `cacheWriteTokens?` | number | `stream_usage.cache_write_tokens` |
| `cacheWrite1hTokens?` | number | `stream_usage.cache_write_1h_tokens` |
| `costTotal?` | number (USD) | `turn_usage.cost_total` (exact or estimate) |
| `costEstimated?` | boolean | `turn_usage.cost_estimated`; only with `costTotal` |
| `sessionSpend?` | number (USD) | `spend_total(&stats.spend, &approx)` after this turn is accounted |
| `sessionSpendEstimated?` | boolean | that call's `approx`; only with `sessionSpend` |

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

All fields from `struct session_stats` accumulators; token fields and
`spend` follow the same omit-when-unreported rule (`-1`/never-reported →
omitted; counters `turns/requests/toolCalls/workedMs` are always present —
zero is a real value there). Semantics are per-sitting (see Non-goals).

Both additions are documented in `docs/protocol.md` in the same commit that
implements them (protocol-is-the-contract).

## §3 Engine (fork) changes — sanctioned seams only

- **Staging** (`src/protocol/emit.{c,h}`): keep `emit_set_usage` as is; add
  `emit_set_turn_costs(struct emit_state *es, const struct emit_turn_costs *tc)`
  taking a small struct (the six §1 values, `-1`/`-1.0` = absent). Staged
  values are consumed and cleared by the next `assistant_turn_finished`
  emission, exactly like the M7 fields.
- **Call site** (`src/agent.c`): at the existing usage-staging point, fill
  `emit_turn_costs` from the freshly built `turn_usage` and
  `spend_total(&st->stats.spend, &approx)` (call after the turn is
  accounted so the running total includes it).
- **Control** (the dispatch that handles `status`/`effort` controls): add
  `session_stats` → handler reads `st->stats`, calls `spend_total`, emits
  via a new `emit_session_stats(...)` in emit.c.
- **Tests** (meson, `HAX_PROVIDER=mock`): extend the usage protocol test
  for the six fields' presence/omission; new `tests/protocol/
  test_session_stats.c` driving the control and asserting the event.
- **Discipline**: run the UPSTREAM.md freshness check before implementation
  (last sync 2026-07-15; the cadence rule requires a pre-feature sync when
  the fork is touched at a notable level); `clang-format -i` on touched C
  files; keep the delta inside the emitter/controls patch surface.

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
  `spend` (`fmtCost`, `~` when estimated). Rows whose numbers were never
  reported are dropped, not zero-filled (upstream's rule).
- **`/usage`**: include cache-write tokens and turn cost lines when the
  new fields are present.
- **Wiring**: standalone runtime passes `sessionStats: () =>
  session.sessionStats()` into the slash context. The ai-whisper adapter
  gains the same one-liner downstream (follow-up, out of this repo's arc).

## §6 Verification

- **C**: the two protocol tests above green in `meson test`.
- **TS**: codec round-trip tests; `statsLine` spend rendering (present /
  estimated / absent / errored-turn suppression); `fmtCost` threshold
  table matching `format_cost`; `/session` render test (full payload +
  dropped-row case + unavailable fallback); harness `sessionStats()` test
  against a scripted event stream.
- **Acceptance (real engine)**: one real-provider turn per surface —
  stats line shows `· $…` (or `· ~$…`), `/session` returns non-zero
  turns/requests and a spend consistent with the transcript footers.
  Evidence committed as an artifact per the slice-1 practice.
