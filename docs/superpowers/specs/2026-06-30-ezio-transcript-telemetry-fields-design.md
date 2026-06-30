# ai-ezio — per-turn telemetry fields (timestamp + model) — design spec

- **Date:** 2026-06-30
- **Status:** approved (design), pre-implementation
- **Visibility:** private
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/specs/` (this file is the synced mirror)

## Problem

ai-14all renders token-usage telemetry (daily/weekly rollups, per-model
attribution) by ingesting agent transcripts. It already ships a full ezio
telemetry driver (`services/usage/providers/ezio.ts`), but that driver is
configured `timeSource: "file-mtime"` — it has no per-turn timestamp to read, so
it stamps **every** turn in a conversation with the filesystem mtime of the
`.record.jsonl` file.

Because `.record.jsonl` is append-only and holds a whole conversation, the file
mtime is the time of the *last* write. Every turn therefore collapses onto that
single instant. A conversation that spans a day/week boundary — or any resumed
session — buckets all of its tokens into the wrong period. The telemetry is
coarse and, across boundaries, wrong.

Separately, ezio telemetry attributes all tokens to an **empty** model string:
ai-14all's `parseEzioLine` reads a top-level `model` field, but ezio's
`.record.jsonl` rows never emit one. The protocol only carries `model` on the
`status` event, which the recorder does not currently track.

claude/codex don't have either problem: their transcript lines carry a per-line
ISO-8601 `timestamp` and a `model`, and ai-14all's drivers for them use
`timeSource: "per-event"`.

## Goals

- Emit a per-turn, end-of-generation `timestamp` (ISO-8601) on each
  `.record.jsonl` row so ai-14all can time-bucket ezio tokens accurately.
- Emit the engine-reported `model` on each row so ai-14all attributes tokens to
  the right model instead of a blank bucket.
- Keep the change entirely in the TypeScript harness (`session-recorder`); no
  hax change, no protocol change, no cortex-projection change.
- Keep the recorder deterministic and unit-testable (no ambient wall clock).
- Stay backward-compatible: additive fields only; pre-existing records and the
  other transcript consumer (ai-cortex) keep working unchanged.

## Non-goals

- No change to `.cortex.jsonl` (the ai-cortex projection). ai-cortex's parser
  reads only `type/turn/message` and ignores extra fields; ai-14all skips cortex
  rows because they carry no `"usage"` marker. Adding telemetry fields there
  would be unused (YAGNI).
- No engine/protocol-level timestamp (no `assistant_turn_finished.timestamp`,
  no hax patch). Reconsider only if a future consumer needs engine-time
  timestamps.
- No migration of historical `.record.jsonl` files. Legacy rows are handled by
  the consumer's mtime fallback.
- No model-id normalization or vocabulary mapping. ai-14all uses `model` only as
  a free-form bucket-key label, exactly as it does for claude/codex.

## Decisions

| Decision                | Choice                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| Where fields are minted | Recorder (owns turn assembly), Approach 1                              |
| Clock                   | Injectable `RecorderOptions.now?: () => number`, default `Date.now`    |
| `timestamp` instant     | Turn finalize (on `idle`) = end of generation                          |
| `timestamp` format      | ISO-8601 with ms, `Date.parse`-able (`new Date(now()).toISOString()`)  |
| `model` source          | Latest observed `status.model`, verbatim                               |
| `model` when unknown    | Field omitted (not emitted as `""`)                                    |
| Surface of change       | `session-recorder` package only; `.record.jsonl` rows                  |
| Cortex projection       | Unchanged                                                              |
| Rollout                 | ezio first (additive), ai-14all second (with mtime fallback)           |

## Contract — the `.record.jsonl` row

Each row gains two additive fields:

```json
{
  "index": 3,
  "timestamp": "2026-06-30T10:41:02.512Z",
  "model": "claude-opus-4-8",
  "userText": "…",
  "assistantText": "…",
  "toolCalls": [ { "name": "Read", "input": "…", "status": "ok" } ],
  "usage": { "contextTokens": 400, "outputTokens": 12, "cachedTokens": 0 }
}
```

- `timestamp` — **required.** ISO-8601 string with millisecond precision,
  parseable by `Date.parse`. Represents the instant the turn finalized (end of
  generation), the same moment `usage` becomes known.
- `model` — **optional.** The engine's reported model id as carried by the
  `status` event, emitted verbatim. Omitted when no `status` has been observed
  for the session.
- All existing fields are unchanged. The `"usage"` substring remains present, so
  ai-14all's `EZIO_MARKER` pre-filter still matches.

## Producer design (ezio)

Approach: the recorder mints both fields, because it already owns turn assembly
and the `status` stream. This keeps the durable store a dumb serializer and
needs no engine or protocol change. The wall clock is injected so tests stay
deterministic (mirrors how `usage` already rides on `RecordedTurn`).

### Components & changes

- **`packages/session-recorder/src/types.ts`**
  - `RecorderOptions.now?: () => number` — wall-clock source; default
    `() => Date.now()`; injected in tests.
  - `RecordedTurn.timestamp: string` — ISO-8601, assigned at finalize.
  - `RecordedTurn.model?: string` — latest `status.model`, when known.

- **`packages/session-recorder/src/recorder.ts`**
  - Resolve `this.now = opts.now ?? (() => Date.now())` in the constructor.
  - Add `private model = ""`.
  - Add `case "status": this.model = event.model; break;` to `handleEvent`.
  - In `finalizeTurn`, before append/sink dispatch, set
    `turn.timestamp = new Date(this.now()).toISOString()` and, when `this.model`
    is non-empty, `turn.model = this.model`.

- **`packages/session-recorder/src/durable-store.ts`**
  - Serialize `timestamp` (always) and `model` (only when present) into the row
    object, near the front for readability.

- **`packages/session-recorder/src/factory.ts`,
  `packages/cli/src/repl/standalone-runtime.ts`** — unchanged. Production uses
  the `Date.now` default.

Three source files change (`types.ts`, `recorder.ts`, `durable-store.ts`).

### Data flow

```
status                → cache latest model (this.model)
user_turn_started     → build current turn (no timestamp yet)
tool_call_*           → accumulate tool calls
assistant_turn_finished → set assistantText + usage
idle                  → finalizeTurn:
                          turn.timestamp = ISO(now())
                          turn.model     = this.model (if set)
                          store.append(turn)  // row carries both fields
                          sink.onTurnComplete(turn)
```

`status` is auto-emitted by hax once right after `ready` in mount mode, so the
model is known before the first turn finalizes. A later `status` (e.g. after a
model/effort switch) updates the cache, and subsequent turns pick up the new
value.

## Error handling & edge cases

- **No `status` seen before a turn finalizes** → `model` is omitted. Defensive
  only; mount-mode auto-status fires after `ready`, before any turn.
- **Model switched mid-session** → each turn records the latest `status.model`.
- **Aborted / empty turn** (an `idle` with no `assistant_turn_finished`, so no
  `usage`) → still stamped with `timestamp`/`model`, but ai-14all skips it
  because it carries no `"usage"` marker. Harmless.
- **Determinism** → tests inject `now`; the recorder reads no ambient clock
  elsewhere.
- **Legacy rows** (written before this change, no `timestamp`) → handled by the
  consumer mtime fallback (below), not by migration.

## Testing (TDD)

- **`recorder.test.ts`**
  - Injected `now` returning a fixed epoch → finalized turn's `timestamp`
    equals `new Date(fixed).toISOString()`.
  - A `status` event with `model` before `idle` → finalized turn carries that
    `model`.
  - No `status` → `model` is `undefined`.
  - Two turns with a `status` change between them → each turn records the
    model in effect at its finalize.
- **`durable-store.test.ts`**
  - Row includes `timestamp`.
  - Row includes `model` when set; omits the key when absent.

## Consumer contract (ai-14all — implemented in that repo)

The producer change is inert until ai-14all reads the new field. Required
changes there:

- **`services/usage/providers/ezio.ts`** — `timeSource: "file-mtime"` →
  `"per-event"`.
- **`services/usage/ezio-source.ts`** — parse the line timestamp:
  `timestampMs = Date.parse(typeof obj.timestamp === "string" ? obj.timestamp : "")`;
  if `NaN`, use `0` as a "fall back to file mtime" sentinel. The existing
  `model` parse already covers the now-populated field. `EZIO_MARKER` stays
  `"usage"`.
- **`services/usage/scanner.ts`** — generalize the file-mtime branch: stamp
  `ch.mtime` whenever `event.timestampMs` is falsy/`NaN` (not only when
  `timeSource === "file-mtime"`). This makes timestamp-less rows — legacy ezio
  records, or any provider row missing a timestamp — bucket by file mtime
  instead of producing an invalid time.
- **Consumer tests**: `ezio-source.test.ts` parses a line `timestamp`; a row
  without `timestamp` yields the `0` sentinel and is stamped with file mtime by
  the processor.

## Rollout & backward compatibility

1. **Ship ezio first.** The new fields are additive. While ai-14all is still on
   `file-mtime`, it ignores `timestamp` entirely — no behavior change, no
   breakage.
2. **Ship ai-14all second.** Its mtime fallback means the per-event driver works
   against both old records (no `timestamp` → file mtime) and new records
   (`timestamp` → accurate buckets). No synchronized deploy is required.

ai-cortex is unaffected throughout: it never reads `.record.jsonl`, and the
`.cortex.jsonl` projection is unchanged.

## Success criteria

- ezio `.record.jsonl` rows carry an end-of-turn ISO-8601 `timestamp` and, when
  known, a `model`.
- ai-14all buckets ezio tokens by real turn-completion time (correct daily and
  weekly rollups) and attributes them to the reported model.
- Pre-existing `.record.jsonl` files still produce sane buckets via the mtime
  fallback.
- The recorder's unit tests are deterministic.
- No change to hax, the protocol, or the cortex projection.
