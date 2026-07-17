# hax → ezio UX parity audit (2026-07-15 sync wave)

**Scope**: the 27 upstream hax commits absorbed by the 2026-07-15 fork sync
(`0faa372..74ab9e9`), audited for UX changes ezio could adopt in its own
TypeScript surfaces. Verdicts are grounded in the actual upstream commit
messages/diffs and the current ezio source (`@ai-ezio/surface`,
`packages/cli/src/repl/`).

**Constraint for this arc** (owner decision): TS-only — no fork/protocol
extensions this round. Items needing new protocol seams are marked
`protocol-gated` and parked for a follow-up arc.

## Ezio surface map (what renders where)

| Surface | Code | Notes |
| --- | --- | --- |
| Mounted renderer | `packages/surface/src/mounted-renderer.ts` | **Shared by both run modes** — standalone REPL calls `createMountedRenderer` too (`standalone-runtime.ts:348`). Spinner, banner, tool calls, markdown, usage line. |
| Prompt input | `packages/cli/src/repl/input-reader.ts` | **Standalone only** (mounted input belongs to whisper's pane). Line-buffered pure reducer: multiline via Alt/Shift+Enter, bracketed paste. **No redraw-style editor** — echo is append-only. |
| Resume picker | `packages/surface/src/resume-picker.ts` (+ cli wrapper) | Used by standalone `--resume` and mounted `/resume` overlay. Keys: arrows, `[`/`]` paging, Ctrl+A, Enter, Esc/q cancel. |
| Slash commands | `packages/surface/src/slash.ts` | `help new status skills copy usage transcript compact`. No selection commands (`/model` etc.). |
| Transcript view | `packages/surface/src/transcript-view.ts` | Pages the engine's `HAX_TRANSCRIPT` mirror file verbatim. |
| One-shot `-p` | `runOneShot` in `standalone-runtime.ts` | Drives the protocol itself — hax's own `-p` chrome (stderr banner, exit stats) does **not** flow through. |

## Verdict key

- **port** — applies nearly as-is, TS-side.
- **adapt** — same idea, different mechanics in ezio's renderer/reducer.
- **free** — arrives via the synced engine with zero ezio work (verify only).
- **protocol-gated** — needs a fork seam extension; parked for the protocol arc.
- **n/a** — does not apply to ezio's architecture.

## A. Spinner (shared renderer — highest mounted-mode value)

### A1. Elapsed-time counter on the busy spinner — `468e433`
Upstream: after a user turn runs 30 s, frames draw `⠋ 42s · working…` —
counter leads the label, computed from the turn's start clock at draw time,
survives label swaps.
Ezio today: fixed `⠋ thinking…`, 80 ms frames, no counter.
**Verdict: port (S).** Renderer already receives `assistant_turn_started`;
arm a timer base there, render `⠋ 42s · thinking…` after the same 30 s
threshold. Skip when the row would overflow terminal width.

### A2. Unified spinner + settle-time label hysteresis — `b987afa`
Upstream: one parked labeled row for all wait states; a specific label
(`[bash] running…`, `thinking…`) appears only after ~2 s of stable state and
demotes to `working…` after ~2 s of churn; pauses in streaming text show
nothing (arriving text is its own progress signal).
Ezio today: spinner label never changes; during tool runs the spinner keeps
saying `thinking…` while the `⏺ tool` line sits above.
**Verdict: adapt (M).** Ezio has the events to do this (`tool_call_started/
finished`, deltas). Port the *label policy* (settle hysteresis + tool-aware
labels + suppress-during-streaming), not the C excursion mechanics — ezio
already owns its line discipline.

## B. Stats, spend, /session

### B1. Stats line rework: duration + spend, scope ordering — `4b97a30`, `8a32185`, `abc0831`
Upstream default line: `42s · 8.9k / 256k (3%) · $0.042` — narrow→wide
(turn activity → window state → session total); labels only where a figure
doesn't self-identify; out/cached demoted to the transcript's per-request
footers.
Ezio today (`usageLine`): `context 8.9k / 256k (3%) · out 2.1k · cached 160k`
— no duration, no spend, wide-first.
**Verdict: split.**
- Turn duration: **adapt (S)** — TS can clock `assistant_turn_started →
  assistant_turn_finished` itself; no protocol change.
- Scope reorder + label trims: **adapt (S)** — pure formatting.
- Session spend `$0.042`: **protocol-gated** — needs the usage cost fields
  (see recorded watch item on the sync-cadence memory).

### B2. `/session` command (turns, requests, tool calls, worked time, spend) — `4b97a30`, `abc0831`
Ezio's slash set has `status` and `usage` but no `/session`.
**Verdict: split.** A TS-side `/session` can count what the protocol
already carries (user turns, tool calls, per-turn durations, token sums
from `usage`). Requests (model round-trips) and spend are engine-side —
**protocol-gated** for full parity. A partial TS `/session` is possible but
would under-report; recommend deferring the whole command to the protocol
arc so its numbers are trustworthy on day one.

### B3. Transcript per-request usage footers — `e0f6bb2`
Upstream appends `ITEM_TURN_USAGE` items rendered in the transcript as
`42s · ~$0.19 · in 20.3k $0.025 · …`.
Ezio's Ctrl+T pages the `HAX_TRANSCRIPT` mirror verbatim, and the engine
writes that mirror color-off (plain text) — so footers arrive as plain
lines with no styling concerns. Upstream also round-trips the footer items
through the session log, so resumed sessions keep them.
**Verdict: free (verify).** One check: run a turn on the new engine and
confirm the footer line appears in the paged view on both surfaces.

## C. Prompt input (standalone only)

### C1. `@file` completion — `596de95`
Upstream: Tab in an `@`-token opens fzf over `git ls-files` (pruned `find`
fallback); editor gained a generic modal-completer seam; fzf required by
design.
Ezio today: no completion of any kind.
**Verdict: adapt (M).** Implement TS-internal fuzzy matching (score over
`git ls-files` output) rendered with the same frame machinery the resume
picker already uses — **no fzf dependency**, preserving the single-bundle
rule (AGENTS.md #6). The input-reader's pure-reducer design wants the same
split upstream used: pure match phase, modal pick phase.

### C2. Prompt viewport cap — `3977f99`
Upstream: sliding cursor-following window over the edit buffer, `… +N
lines` frame rows, capped at ~40 % of viewport; depends on their
repaint-based editor.
Ezio today: append-only echo, no repaints — the documented limitation
(backspace across newline has imperfect echo) marks the missing layer.
**Verdict: defer (L).** Not portable until ezio has a redraw-style line
editor; the cap is a property of that editor, not a bolt-on. Revisit if/when
input-reader grows a repaint model (which would also fix the backspace-echo
wart).

## D. Pickers

### D1. PageUp/PageDown navigation — `0cd58d5` (prior wave, same family)
Ezio pages with `[` / `]`.
**Verdict: port (S).** Add PgUp/PgDn (`ESC[5~`/`ESC[6~`) as aliases in
`resume-picker.ts`; both surfaces benefit (mounted `/resume` overlay uses
the same code). Update hint strings.

### D2. Provider picker: selectable dim rows, exact reasons — `0051502`;
### model-picker errors + Esc abort — `5c7fc37`; model sort — `7498026`
Ezio has no provider/model pickers — selection is engine-side config; no
protocol control exists to change selection from a mounted pane.
**Verdict: n/a now / protocol-gated later.** These become the UX spec for
ezio's future selection pickers when the reconfigure control lands (the
fork already carries `agent_session_reconfigure` + `emit_status`). Esc-abort
semantics in the existing resume picker already match upstream's rule.

## E. Banner & one-shot chrome

### E1. Banner reprint on settings change (empty conversation) — `4409fe7`
**Verdict: n/a (TS-only).** Ezio surfaces can't change settings
mid-session yet; becomes relevant with the selection-controls arc. The
design rule to carry over: reprint the banner only on an empty
conversation; mid-conversation use a dim marker.

### E2. `-p` stderr banner + provider auto-select — `149001d`
Upstream `-p` prints `provider · model · effort` (marked `(auto-selected)`
when inferred) to stderr; auto-select now shared with the REPL.
Ezio's `runOneShot` owns its own chrome, so nothing flows through.
Auto-select itself is engine-side → **free**.
**Verdict: adapt (S).** Print the same one-line stderr banner from the
`status` event ezio already receives at ready. Exit stats line: duration is
TS-computable now; spend is protocol-gated (consistent with B1).

### E3. Shorter llama.cpp model labels — `e4c1299`
Model names flow through `status` events. **Verdict: free.**

## F. Renderer internals

### F1. Flicker avoidance without DEC 2026 — `7af8415`
Upstream: draw new frames before clearing stale tails; keep synchronized-
output wrapping where supported.
Ezio: spinner frames are single `write()` calls (clear+draw in one chunk);
the picker repaints frames wholesale.
**Verdict: evaluate (S).** Likely a non-issue for the spinner; apply the
draw-before-clear ordering to picker frame repaints if flicker is observed
under tmux. No dedicated work item unless reproduced.

## G. Engine-internal — inherited free with the sync (no ezio work)

| Item | Commit | Note |
| --- | --- | --- |
| `reasoning_effort` → `effort` rename | `0103036` | Already reconciled in the sync. |
| Selections bound to their provider | `2ecb4b3` | Engine config semantics. |
| `(default)` sentinel resolution | `efe598e` | Engine config semantics. |
| Catalog spend estimation + tier pricing | `8934eba`, `ac53894` | Feeds future spend display. |
| OpenRouter attribution headers | `d8b0393` | Wire-level. |
| codex CLI impersonation (gpt-5.6-luna) | `4224765` | Wire-level. |
| bash preferred over `/bin/sh` | `5c375b3` | Tool behavior. |
| Compaction seed flagged, not fake prompt | `c765a3a` | Cleaner transcripts + resume previews. |
| Mid-work update prompt guidance | `7ffd74b` | System-prompt text. |
| Docs reorg / test fixes | `2ed0e9e`, `74ab9e9` | — |

Out of scope for a UX arc: native subagent support (`e7d8af3`) — a feature/
architecture decision tracked in the subagent-v1 backlog memory.

## Summary table

| # | Item | Verdict | Effort | Surfaces |
| --- | --- | --- | --- | --- |
| A1 | Spinner elapsed counter | port | S | both |
| A2 | Tool-aware settle labels | adapt | M | both |
| B1a | Usage line: turn duration + scope reorder | adapt | S | both |
| B1b | Session spend in stats line | protocol-gated | — | both |
| B2 | `/session` command | protocol-gated (partial TS possible, not recommended) | — | both |
| B3 | Transcript usage footers | free (verify) | XS | both |
| C1 | `@file` fuzzy completion | adapt | M | standalone |
| C2 | Prompt viewport cap | defer (needs redraw editor) | L | standalone |
| D1 | Picker PgUp/PgDn | port | S | both |
| D2 | Provider/model picker UX | protocol-gated | — | both |
| E1 | Banner reprint on settings change | protocol-gated | — | both |
| E2 | `-p` stderr banner (+duration exit line) | adapt | S | standalone |
| F1 | Flicker draw-before-clear | evaluate | S | both |

## Recommended slice plan

1. **Slice 1 — mounted polish** (shared renderer, ships to the daily
   driver): A1 spinner counter, A2 settle labels, B1a usage-line
   duration + reorder, D1 picker keys, B3 footer verification, F1 flicker
   check. All S/M, one package (`@ai-ezio/surface`) plus one small
   runtime hook for turn timing.
2. **Slice 2 — standalone input**: C1 `@file` fuzzy completion (M),
   E2 `-p` stderr banner (S). C2 stays deferred with its precondition
   named (redraw editor).
3. **Slice 3 — protocol arc** (separate, already parked): usage cost/
   cache-write fields (watch item on the sync-cadence memory), session
   stats seam, selection controls → unlocks B1b, B2, D2, E1.

Each slice: own spec → plan → implementation cycle per the superpowers
flow.
