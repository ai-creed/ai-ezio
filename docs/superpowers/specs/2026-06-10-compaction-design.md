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
{"type": "compact", "summary": "<text>", "keepLastTurns": 2}
```

A pure helper `agent_session_compact(sess, summary, keep_k)` in
`agent_core.{c,h}`:

- **Cut point:** walk `items` backward to the start of the K-th-from-last
  `ITEM_USER_MESSAGE`. Cutting at user-message starts (not
  `ITEM_TURN_BOUNDARY`, which marks HTTP round-trips) guarantees
  tool_call/tool_result pairs and reasoning items never straddle the cut.
- **Swap:** new vector = `[ITEM_USER_MESSAGE carrying the summary text]` +
  tail items verbatim (including opaque `reasoning_json`). Dropped items are
  freed. The operation is atomic in memory: it fully applies or the session is
  untouched.
- **Bounds:** `keepLastTurns >= 0` (`0` = summary only — valid generic
  operation; host policy simply defaults higher). `keepLastTurns >=` current
  user-turn count → no-op success with `droppedItems: 0`. `summary` is
  required non-empty. An invalid control (empty summary, missing/negative
  `keepLastTurns`) leaves the session untouched and emits an `error` event,
  like other malformed controls.
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
- `@ai-ezio/harness`: `session.compact(summary, keepLastTurns)` — sends the
  control, resolves on `compacted`; the event also flows to all `onEvent`
  subscribers (surface, recorder).

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
(one `register()` call). Cycles only start at idle and are guarded by an
in-progress flag; both run loops are sequential, so no mid-turn race exists.
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
4. `session.compact(text, keepLastTurns)` (default 2).
5. Render the outcome.

The summarization turn itself is swapped out by step 4 — it never pollutes
post-compact history. The recorder, by contrast, records it like any turn
(the lossless record keeps it; see section 6).

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
  survival beats summary quality at 0.8 fullness.
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
  placement, empty-summary rejection.
- **Engine e2e:** real hax + mock provider — three turns, send
  `compact keepLastTurns=1`, assert via the `HAX_TRANSCRIPT` mirror that the
  next provider request contains exactly summary + last turn; assert
  `compacted` → `idle` ordering; assert the rotated session log resumes to
  post-compact state.
- **Protocol:** codec round-trip + absence coverage for both messages.
- **Compactor unit:** fake session + fake rehydrator — threshold arming,
  in-progress guard, digest fallback, abort + re-arm rule, unknown-limit
  disarm, config clamping.
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
