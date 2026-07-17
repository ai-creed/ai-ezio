# UX slice 1 — mounted renderer polish (spinner, stats line, picker keys)

**Date**: 2026-07-15
**Source**: `docs/superpowers/knowledge-references/2026-07-15-hax-ux-parity-audit.md`
(items A1, A2, B1a, D1, B3, F1), porting upstream hax UX from the 2026-07-15
sync wave (`b987afa`, `468e433`, `4b97a30`, `8a32185`, `abc0831`) into ezio's
TypeScript surface.
**Package**: `@ai-ezio/surface` only. TS-only — no engine, protocol, or
harness changes.

## Context

`createMountedRenderer` serves both run modes (the standalone REPL calls it
too), so everything here ships to the whisper collab pane and the standalone
CLI at once. Two defects motivate the slice beyond parity:

1. **Dead air during tools.** The spinner starts at `user_turn_started` and
   is killed by the first `tool_call_started` — nothing restarts it. A long
   tool run and every post-tool reasoning stretch render as a frozen pane.
2. **The pane's only liveness signal is the spinner.** Mounted mode
   suppresses `assistant_delta` (markdown renders at turn end), so upstream's
   "hide the spinner while text streams" rule inverts: ezio's spinner must
   stay parked for the whole turn.

## Goals

- Spinner alive for the entire user turn with truthful, tool-aware labels
  (upstream `b987afa`, adapted).
- Elapsed-time counter on long turns (upstream `468e433`, ported).
- Stats line reworked to narrow→wide scope order with turn duration
  (upstream `4b97a30` + `8a32185` + `abc0831`, minus spend).
- PageUp/PageDown aliases in the shared picker.
- Two zero-code verification tasks (transcript footers, tmux flicker).

## Non-goals

- Session spend / `/session` / selection pickers — protocol-gated (slice 3).
- Input-reader work (`@file`, viewport) — slice 2.
- Any change under `vendor/hax` or `packages/protocol`.

## Design

### 1. Spinner model — new `packages/surface/src/spinner-model.ts`

A pure reducer, same style as `input-reader.ts`: no timers, no I/O; the
renderer owns the 80 ms tick and asks the model what to draw.

```ts
type SpinnerState =
  | { kind: "idle" }
  | { kind: "thinking" }          // turn running, no tool in flight
  | { kind: "tool"; name: string }; // tool_call_started .. finished

interface SpinnerModel {
  /** Protocol events that affect the spinner. Returns the new model. */
  reduce(event: ProtocolEvent, nowMs: number): SpinnerModel;
  /** What the tick should draw. null = spinner hidden. */
  frame(nowMs: number, frameIndex: number, columns: number): string | null;
}
```

**State transitions** (from `reduce`):

| Event | Transition |
| --- | --- |
| `user_turn_started` | → `thinking`; arm `turnStartAt = now` |
| `tool_call_started` | → `tool(name)` |
| `tool_call_finished` | → `thinking` |
| `assistant_turn_finished`, `idle`, `error` | → `idle`; disarm timer |

**Label policy** (upstream's settle hysteresis, constants exported for
tests):

- `SETTLE_MS = 2000`, `CHURN_MS = 2000`, `COUNTER_MS = 30000`, tick 80 ms.
- Labels: `thinking…` for `thinking`, `[name] running…` for `tool`,
  `working…` as the neutral demotion.
- When the spinner becomes visible (`idle → thinking`), the specific label
  shows **immediately** — ground truth on first draw.
- On a mid-turn state change, the displayed label keeps the previous settled
  label for up to `SETTLE_MS`; the new state's specific label is adopted once
  the state has been held `SETTLE_MS`. If states keep churning (no state
  held `SETTLE_MS` for longer than `CHURN_MS` since the first unsettled
  change), display demotes to `working…` until some state settles.
- Rationale: a 300 ms `read` burst between two thinking stretches never
  flashes `[read] running…`, and a rapid tool loop reads `working…` instead
  of strobing names — upstream's exact intent.

**Elapsed counter**:

- Armed at `user_turn_started`, disarmed at turn end; survives label swaps
  (computed from `turnStartAt` at draw time).
- Hidden until `now - turnStartAt >= COUNTER_MS` (30 s, upstream's and
  Claude Code's threshold), then drawn leading the label:
  `⠋ 42s · thinking…`. Counter format: integer seconds below 60, `1m 32s`
  above.
- Width guard: if `frame + counter + label` would exceed `columns - 1`,
  drop the counter (upstream skips it on overflow); the label itself is
  already bounded (tool names are short; no further truncation logic).

**Frames**: current braille set when `utf8: true`; `["-", "\\", "|", "/"]`
when `utf8: false` (fixes the pre-existing unconditional-braille wart).

### 2. Renderer integration — `mounted-renderer.ts`

The spinner needs to survive content writes instead of dying on them. One
row-discipline rule replaces the current start/stop calls:

- Renderer keeps `spinnerRowOpen: boolean`.
- **Every content write goes through one guard**: `writeContent(s)` —
  clear the spinner row if visible, write `s`, set `spinnerRowOpen = false`.
  Tool headers, tool output, markdown, usage line, error lines, prompt all
  use it (mechanical replacement of direct `w()` calls for content paths).
- **Tick**: ask `model.frame(now, i, columns)`. If `null`, clear the row if
  visible. Otherwise, if `!spinnerRowOpen`, first `w("\n")` and mark the row
  open (this is upstream's "parked one line below the content"), then
  `CLEAR_LINE + frame` as today.
- Event handling: the `switch` forwards every event to `model.reduce` and
  drops the manual `startSpinner`/`stopSpinner` calls; visibility is now a
  pure consequence of model state. The idle-safety guard (stale interval
  writes nothing) stays.

Net behavior change: after `tool_call_started` renders `⏺ bash · cmd`, the
next tick opens a fresh row below it and the spinner continues as
`⠋ [bash] running…` (settling per the label policy); after
`tool_call_finished` output, it continues as `working…`/`thinking…` until
the turn ends. The `⏺` header lines stay in scrollback untouched.

### 3. Stats line — `usageLine` rework in `mounted-renderer.ts`

New default form, narrow→wide (upstream `8a32185`):

```
42s · 8.9k / 256k (3%)
```

- **Duration**: renderer records `turnStartAt` at `user_turn_started` and
  `turnElapsedMs` at `assistant_turn_finished`; the stats line renders at
  `idle` as today. Same formatting as the spinner counter (`42s`, `1m 32s`).
- **Context gauge**: `8.9k / 256k (3%)` unlabeled when the limit is known —
  the gauge shape self-identifies (upstream `abc0831`'s labeling rule);
  `context 8.9k` when the limit is unknown.
- **`out` / `cached` are dropped from the line.** Upstream demoted them to
  the transcript's per-request footers, which ezio now gets free via the
  `HAX_TRANSCRIPT` mirror (audit B3). The full payload remains visible in
  the `/usage` slash command, which is unchanged.
- **Errored turns render no stats line** (upstream's
  `!user_turn_errored` gate): if an `error` event carrying a `turnId`
  arrived since the turn started, suppress the line for that turn. A turn
  with timing but no usage payload renders duration alone.

### 4. Picker keys — `resume-picker.ts`

- `ESC[5~` (PageUp) ≡ `[`, `ESC[6~` (PageDown) ≡ `]` in the key decoder
  (escape sequences already arrive whole per the module's contract).
- The paged hint variant (`HINTS_PAGED`, the only one naming `[ ]`) gains
  the aliases:
  `↑/↓ move · [ ]/PgUp/PgDn page · Ctrl+A all · Enter select · Esc cancel`.
  The single-page and all-pages variants are unchanged — they name no
  paging keys.

### 5. Verification tasks (no code unless they fail)

- **B3 — transcript footers**: one real turn on the 0.4.1 engine per
  surface; confirm each completed request's per-request stats footer line
  (`42s · ~$0.19 · in … · out …`) appears in Ctrl+T / `/transcript` as
  plain text, placed after that request's items. The `HAX_TRANSCRIPT`
  mirror is deliberately color-off (`transcript.c` renders it with color
  off), so the pass condition is footer **content and placement only** —
  the dim treatment exists solely in hax's own TUI and is not observable
  here. If a footer is missing, that is an engine/transcript-wiring bug to
  triage, not a renderer change.
- **F1 — tmux flicker**: open the resume picker under tmux without DEC 2026
  support, page rapidly. Only if an intermediate blank frame reproduces,
  reorder that repaint to draw-before-clear (upstream `7af8415`'s rule) as a
  follow-up fix inside `resume-picker.ts`.

## Error handling

- Spinner model treats unknown events as no-ops (`reduce` returns itself) —
  forward-compatible with new protocol event types.
- A non-turn (fatal) `error` hides the spinner and disarms the timer, same
  as turn end — the pane must never show a live spinner over a dead engine.
- `columns` falls back to 80 when `stdout.columns` is undefined (non-TTY
  test streams), matching the markdown renderer's existing behavior.
- **Auto-compaction: no interaction by construction.** The shared
  `createAutoCompactDriver` compacts after `idle` (spinner already hidden),
  and both surfaces suppress renderer events while `compacting()` — the
  injected summarize turn's events never reach the spinner model. The
  renderer's `compacted`/unknown-event no-op behavior is unchanged.

## Testing

Vitest, `@ai-ezio/surface`, reusing the existing injectable seams
(`setInterval`/`clearInterval` inputs, fake `stdout` writable):

- **spinner-model.test.ts** (pure, no timers): transition table; label
  settle at exactly `SETTLE_MS`; demote-to-`working…` under churn and
  recovery after settling; counter hidden at 29.9 s / shown at 30 s;
  counter survives a label swap; width guard drops counter, never the
  label; ASCII frames when `utf8: false`; unknown events are no-ops.
- **mounted-renderer.test.ts** (extend): spinner row re-opens below a tool
  header (`\n` before first post-content frame); content writes always
  clear the spinner row first; spinner runs during a tool (frames between
  `tool_call_started` and `tool_call_finished`); stats line format for
  known-limit / unknown-limit / error-suppressed / duration-only turns.
- **resume-picker.test.ts** (extend): PgUp/PgDn page exactly like `[`/`]`;
  hints include the aliases.

After drafting, sweep for existing helpers (fake-stdout builders, event
fixtures) before keeping any bespoke test scaffolding.

## Files

| File | Change |
| --- | --- |
| `packages/surface/src/spinner-model.ts` | new — pure spinner reducer |
| `packages/surface/src/mounted-renderer.ts` | row discipline, model wiring, stats line |
| `packages/surface/src/resume-picker.ts` | PgUp/PgDn aliases + hints |
| (tests alongside each) | as above |

Three source files — within the split threshold.

## Rollout

1. Land in `@ai-ezio/surface`, full gate (`pnpm -r build && pnpm -r test`,
   `pnpm lint`, `pnpm format:check`, `smoke:cli-mount`).
2. Standalone verification: `ai-ezio` REPL, run a tool-using turn, watch
   spinner labels + stats line; `--resume` picker paging.
3. Mounted propagation: rebuild ai-whisper + reinstall global whisper
   (the bundled-snapshot recipe), restart collab, repeat the turn check in
   the pane.
4. B3/F1 verification tasks folded into steps 2–3.
