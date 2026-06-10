# ezio context compaction — design

**Status:** approved (brainstorm 2026-06-10)
**Date:** 2026-06-10
**Scope:** one new engine control/event pair (`vendor/hax`, inside the
documented seam budget), protocol + harness plumbing, a TS-owned Compactor
shared by standalone and mounted modes, `/compact`, config, recorder/cortex
integration.

## Motivation

hax never compacts or summarizes: the in-memory `items` vector grows until the
model's context limit, and the only relief is `new_conversation`, which wipes
everything. Long coding sessions therefore hit a hard wall. ezio needs
compaction — condensing older history while preserving recent fidelity — as a
first-class, protocol-native operation.

Two engine facts anchor the design:

- The engine already reports what an auto-trigger needs:
  `assistant_turn_finished.usage` carries `contextTokens` and `contextLimit`
  (provider-probed, or `HAX_CONTEXT_LIMIT` override).
- The engine already knows how to rebuild its history: `--resume` reconstructs
  the `items` vector from a session JSONL; `new_conversation` clears it.

## Decisions (from brainstorm)

| Question | Decision |
| --- | --- |
| Trigger | Auto at a fullness threshold (config-gated, **default on**) + manual `/compact` |
| What survives | Summary + last K turns verbatim + optional ai-cortex rehydration block |
| Summarizer | In-session self-summarization (the model summarizes from its own context) |
| Swap mechanism | New `compact` engine control (Approach A; the surviving tail must be real engine items — paired tool_call/tool_result, opaque reasoning — which TS never holds at item fidelity) |

Rejected alternatives: pure-TS `new_conversation` + seeded prefix (tail
degrades to user-quoted text — a throwaway hack); session-file surgery +
respawn (TS writing hax's private session schema is scraping-adjacent; restart
disrupts MCP registration and mounted clients).

## 1. Engine seam — `compact` control + `compacted` event

The only C change. An idle-time control handled alongside `new_conversation`:

```json
{"type": "compact", "summary": "<text>", "keepLastTurns": 2, "dropLastTurns": 1}
```

A pure helper `agent_session_compact(sess, summary, keep_k, drop_d)` in
`agent_core.{c,h}`:

- **Drop window:** first discard the newest `dropLastTurns` turns entirely
  (default 0). A "turn" starts at an `ITEM_USER_MESSAGE`; the drop also covers
  a dangling user-message-only turn (e.g. a pre-stream failure) and an
  absorbed-aborted turn. The engine does not know *why* the host drops
  trailing turns — for the ezio Compactor it is how the in-session
  summarization exchange is excluded (section 3), but the mechanism is
  host-agnostic.
- **Cut point:** in what remains, walk `items` backward to the start of the
  K-th-from-last `ITEM_USER_MESSAGE`. Cutting at user-message starts (not
  `ITEM_TURN_BOUNDARY`, which marks HTTP round-trips) guarantees
  tool_call/tool_result pairs and reasoning items never straddle the cut.
- **Swap:** new vector = `[ITEM_USER_MESSAGE carrying the summary text]` +
  tail items verbatim (including opaque `reasoning_json`). Dropped items are
  freed. The operation is atomic in memory: it fully applies or the session is
  untouched.
- **Bounds:** `keepLastTurns >= 0` (`0` = summary only — valid generic
  operation; host policy simply defaults higher); `dropLastTurns >= 0`.
  `dropLastTurns >=` current turn count → vector becomes `[summary]` only.
  After dropping, `keepLastTurns >=` remaining turn count → no further items
  dropped (`droppedItems` counts only the summarized-away prefix plus the
  drop window). `summary` is required non-empty. An invalid control (empty
  summary, missing/negative `keepLastTurns`, negative `dropLastTurns`) leaves
  the session untouched and emits an `error` event, like other malformed
  controls.
- **Logs:** the session log rotates to a fresh file (same mechanism as
  `new_conversation`) and the full post-compact history is appended to it, so
  `--resume` of the new file reproduces post-compact state exactly. The
  `HAX_TRANSCRIPT` mirror is reset and re-seeded the same way.
- **Confirm:** emit `compacted` then `idle` (mirroring the `new_conversation`
  path's explicit `on_idle`), so `waitForEvent("idle")` patterns work
  unchanged:

```json
{"type": "compacted", "droppedItems": 57, "keptTurns": 2}
```

The engine learns nothing about why compaction happened or what the summary
contains — pure mechanism, zero policy. Footprint: `src/protocol/emit.{c,h}`
(control parse + event emit), ~30 lines in `agent.c` (idle-loop handler),
`agent_core.{c,h}` (the helper), tests under `tests/protocol/` — all inside
the patch-surface budget defined in `UPSTREAM.md`. Per working agreement #4,
`docs/protocol.md` documents both messages **before** implementation.

Version skew: ezio ships engine + harness as one bundle, so a new-harness /
old-engine pairing does not occur in practice; the harness already
version-gates on `ready`.

## 2. Protocol + harness plumbing

- `@ai-ezio/protocol`: `compact` control and `compacted` event types + codec
  entries, with presence/absence coverage like M7/M8.
- `@ai-ezio/harness`: `session.compact(summary, keepLastTurns, dropLastTurns)`
  — sends the control, resolves on `compacted`; the event also flows to all
  `onEvent` subscribers (surface, recorder).

**Session turn gate.** The harness `Session` gains an internal async mutex (a
promise-chain) that every turn-initiating operation acquires: `submit`,
`submitAndWait`, `newConversation`, and `compact`. This is the explicit
serialization contract for both modes: `idle` is precisely the signal that
releases a mounted caller to submit its next turn, so "cycles start at idle"
alone cannot prevent a client submit from interleaving into a compaction
cycle. The Compactor acquires the gate **once for its entire cycle**
(summarize → compose → compact), so a concurrent caller's submit either runs
to completion before the cycle starts or waits until the cycle has landed —
it can never fall inside it. After acquiring the gate, the auto-trigger
re-checks its arming condition (still idle, fullness still ≥ threshold with
the latest usage) before proceeding, since a turn that ran while it waited
changed both. Raw-protocol clients that bypass the harness get a documented
ordering rule in `docs/protocol.md` instead: the engine processes controls
strictly in arrival order at idle boundaries, so a host driving `compact`
directly must not interleave its own `submit` between its cycle's steps.

**Caller-visible gate contract.** Internal ordering alone is not enough,
because the existing public API is fire-and-forget: today
`submit()` writes the control immediately, and the standalone REPL sequences
turns as `session.submit(text); await session.waitForEvent("idle")`
(`packages/cli/src/repl/standalone.ts`). Under a gate, a queued `submit()`
returns before its control is written, and that bare idle-waiter would
resolve on a compaction cycle's idle — the REPL would prompt mid-cycle. The
gate therefore ships with three API guarantees:

1. **`submit(text)` returns a promise** that resolves only after the gate has
   been acquired and the control actually written. It stays fire-and-forget
   with respect to the *turn*, but is strictly ordered with respect to
   cycles.
2. **`submitAndWait` is the gated full-turn primitive**: it holds the gate
   from control write until its own turn's `idle`, then releases. Because
   the gate excludes all other turn initiators, "the next idle after my
   submit" is provably *mine*. The standalone REPL migrates from the bare
   pattern to this primitive (the surface keeps rendering from `onEvent`;
   only sequencing changes), and the ai-whisper adapter's submit-strategy
   does the same as part of its Compactor wiring.
3. **Cycle-internal idle suppression**: while the Compactor holds the gate,
   the idles produced inside the cycle (the summarize turn's idle and the
   post-`compacted` idle) do not resolve `waitForEvent("idle")` waits created
   outside the critical section — the gate-holder's own waits are exempt,
   and `onEvent` subscribers (renderer, recorder) still see every event
   unchanged. This makes even a legacy/external `submit` + `waitForEvent`
   caller safe rather than merely deprecated.

## 3. Compactor — TS policy owner, shared by both modes

New module `compactor.ts` in `@ai-ezio/harness`, constructed with:

- the harness session,
- resolved compaction config (section 5),
- an **injected** `rehydrate?: () => Promise<string | null>` callback.

The injection keeps layering clean: the harness never depends on `mcp-host`.
The standalone CLI and the ai-whisper adapter — which already call
`loadMcpHost` — wire the cortex callback via the host's tool-calling surface
(`callHostTool` → e.g. cortex pinned memories / rehydration). The returned
block is truncated to 4,000 characters (fixed constant; not config — YAGNI
until proven otherwise).

**Trigger.** The Compactor tracks the latest `contextTokens`/`contextLimit`
from each `assistant_turn_finished.usage`. At each `idle`: if `auto` is
enabled and `contextTokens / contextLimit >= threshold` (default 0.8), run a
cycle. `/compact` runs the same cycle manually via the existing slash registry
(one `register()` call). Every cycle runs as a single critical section under
the session turn gate (section 2) — that, not idle timing, is what makes
auto and manual compaction safe against a concurrent mounted submit — and an
in-progress flag makes reentry (`/compact` during a cycle) a friendly no-op.
Manual `/compact` does not read the limit at all — it works even when
`contextLimit` is unknown.

**Cycle.**

1. `submitAndWait` a fixed summarization instruction — the model summarizes
   from its own context: task state, key decisions, files touched, open
   threads, next steps. The 0.8 trigger guarantees headroom for this turn.
2. Await the injected rehydration callback (if configured and enabled) → a
   bounded cortex block.
3. Compose the summary block: header (`[Context summary — session compacted]`)
   + model summary + cortex block.
4. `session.compact(text, keepLastTurns, dropLastTurns)` (defaults: keep 2,
   drop 1).
5. Render the outcome.

The summarization exchange of step 1 is itself the newest turn in the
engine's `items` when step 4 runs — without an explicit drop, the backward
cut walk would count it as tail and post-compact history would be summary +
K−1 real turns + the summarize turn. `dropLastTurns: 1` is what excludes it:
the Compactor sets it to 1 whenever its summarization submit reached the
engine (succeeded **or** was absorbed as an aborted/dangling turn), and 0 only
when no summarize turn was ever submitted. Post-compact history is therefore
always summary + the last K *real* turns. The recorder, by contrast, records
the summarize turn like any other (the lossless record keeps it; see
section 6).

**UX during the cycle (standalone).** The surface suppresses normal assistant
rendering for the summarize turn and shows a compacting indicator (spinner +
`compacting…`); on completion it prints one chrome line:

```
✦ compacted — dropped 57 items, kept last 2 turns
```

(No "before → after tokens" claim: the engine has no tokenizer, so the new
context size is only known at the next turn's `usage` — which displays it
naturally.) In mounted mode the `compacted` event reaches the client;
rendering is the client's choice. A mounted client may also send the `compact`
control directly — the protocol is the contract.

**Failure handling.**

- Summarize turn fails (provider error, interrupt): fall back to a
  deterministic TS digest built from the recorder's turns (user goals,
  assistant text truncated, tool names + file paths) and still compact —
  survival beats summary quality at 0.8 fullness. The failed summarize turn
  still entered history (the engine absorbs aborted turns, and a pre-stream
  failure leaves a dangling user message), so the fallback compact also sends
  `dropLastTurns: 1`.
- Digest also unavailable (e.g. recorder disabled): abort untouched, print a
  warning, and re-arm only after `contextTokens` exceeds its
  failure-time value by 2% of `contextLimit` — no retry-every-turn loops.
- `contextLimit` unknown: auto-compact disarms silently; `/usage` shows no
  limit and `doctor` reports "auto-compact inactive: context limit unknown
  (set HAX_CONTEXT_LIMIT)". Manual `/compact` still works.
- `compact` control fails or times out: abort the cycle; the engine is
  untouched (atomicity above), surface a warning, same re-arm rule.

## 4. `/compact` and `/usage`

- `/compact` — manual trigger; "compaction already in progress" if reentered;
  prints the same chrome line on success.
- `/usage` — when both `contextTokens` and `contextLimit` are present, append
  a fullness percentage (e.g. `context 142k · limit 200k · 71%`).

## 5. Config

New general-settings file `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/config.json`
(sibling of `mcp.json`, which stays MCP-only). The loader lives in
`@ai-ezio/harness` (fs + JSON only, no mcp-host dependency); missing file or
section means defaults.

```jsonc
{
  "compaction": {
    "auto": true,          // opt-out switch for the auto trigger
    "threshold": 0.8,      // fullness ratio that arms auto-compact
    "keepLastTurns": 2,    // verbatim tail size
    "rehydrate": true      // cortex enrichment; ignored when no rehydrate callback is wired
  }
}
```

Out-of-range values clamp to sane bounds (`threshold` ∈ [0.3, 0.95],
`keepLastTurns` ∈ [0, 10]) with a doctor-visible note.

## 6. Ecosystem fit (recorder + cortex)

The recorder has already captured every pre-compact turn losslessly, so
nothing is lost to cortex when the model's context shrinks. It observes
`compacted` and flushes with `reason: "compact"`; the conversation id does
**not** increment — compaction is a continuation, not a boundary. The loop
this closes is the ecosystem leverage: **cortex keeps the lossless record, the
model carries the lossy summary, and rehydration injects back the durable
rules worth carrying forward.**

## 7. Testing (TDD throughout)

- **Engine unit (`tests/protocol/`):** `agent_session_compact` cut-point
  cases — tool pairs adjacent to the cut, reasoning items in the tail,
  `keepLastTurns` ≥ turn count no-op, `keepLastTurns: 0`, summary item
  placement, empty-summary rejection; `dropLastTurns` cases — 0 and 1,
  dropping a dangling user-message-only trailing turn, dropping an
  absorbed-aborted trailing turn, `dropLastTurns` ≥ turn count →
  summary-only vector.
- **Engine e2e:** real hax + mock provider — three turns, send
  `compact keepLastTurns=1 dropLastTurns=1`, assert via the `HAX_TRANSCRIPT`
  mirror that the next provider request contains exactly summary + the
  second turn (newest turn dropped, prefix summarized); assert
  `compacted` → `idle` ordering; assert the rotated session log resumes to
  post-compact state.
- **Protocol:** codec round-trip + absence coverage for both messages.
- **Compactor unit:** fake session + fake rehydrator — threshold arming,
  in-progress guard, digest fallback (including that it sends
  `dropLastTurns: 1`), abort + re-arm rule, unknown-limit disarm, config
  clamping with the doctor-visible note emitted.
- **Turn gate:** harness tests proving the caller-visible contract, not just
  event ordering — (a) a `submit` issued while a compaction cycle holds the
  gate is deferred until after `compact` lands, and its returned promise
  resolves only once the control is actually written; (b) the **legacy
  pattern regression test**: fire `submit(text)` *unawaited* and immediately
  `waitForEvent("idle")` while a cycle is in flight, and assert the waiter
  resolves on the queued user turn's idle — never on the cycle's summarize
  or post-`compacted` idles; (c) `onEvent` subscribers receive all
  cycle-internal events unchanged during suppression; (d) the auto-trigger
  re-checks fullness after acquiring the gate; (e) `submitAndWait` resolves
  with its own turn's content when a cycle was queued behind it.
- **Full-cycle integration:** drive a complete Compactor cycle against real
  hax + mock provider and assert via the `HAX_TRANSCRIPT` mirror that the
  next provider request contains the summary + the last K real turns and
  **no trace of the summarization instruction or its assistant reply**.
- **Recorder:** observes `compacted` → flushes with `reason: "compact"`,
  conversation id unchanged.
- **CLI:** `/compact` registry + reentrancy message; a standalone-REPL
  mock-provider run that drives a full auto-compact cycle.

## Non-goals

- Pinned / never-compacted items (layers on later via the same control).
- Any ai-whisper repo change beyond the adapter wiring the same Compactor.
- `tool_call_delta`, streaming changes.
- Engine-side summarization or policy of any kind.

## Sequencing

This feature touches the fork, which per `UPSTREAM.md`'s sync strategy
requires starting from a fresh upstream sync — satisfied by the 2026-06-10
sync. Protocol doc update lands first (working agreement #4), then engine seam
(TDD), then protocol/harness plumbing, then Compactor + CLI + config, then
recorder integration.
