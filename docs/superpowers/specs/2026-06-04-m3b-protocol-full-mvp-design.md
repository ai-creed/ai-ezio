# M3b — Protocol full-MVP design spec

- **Date:** 2026-06-04
- **Status:** approved (extracted from the parent M3 spec), pre-implementation
- **Milestone:** M3b (the "widen the slice to the full M3 set" half of M3)
- **Parent spec:** `docs/superpowers/specs/2026-06-03-m3-protocol-mvp-design.md`
  (this carves out and tightens its "M3b — full MVP" section into a standalone,
  SDD-runnable spec; M3a is already implemented and verified)
- **References:** `docs/protocol.md`, `UPSTREAM.md`, `docs/architecture.md`,
  `docs/superpowers/plans/2026-06-03-m3-protocol-mvp.md` (Phase M3b)
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/specs/` (this file is the synced mirror)

## Purpose

M3a proved the feasibility loop: the TS harness drives the patched hax over
inherited fds with an authoritative handback and no scraping. M3b **widens the
same mechanism** — the upstreamable `agent_observer` seam + the downstream
`emit.c` + the single `on_event` hook — to the full M3 event/control set, without
a rewrite. When M3b lands, the entire enumerated M3 protocol surface flows over
the fds, and M3 is complete.

## What M3a already delivered (the baseline M3b builds on)

- hax: `agent_observer` seam, `emit.c` (lifecycle JSONL + control reads),
  `--protocol-fd`/`--control-fd`, the `on_event` hook (currently `EV_TEXT_DELTA`
  only), `submit` input-swap, `interrupt` via the stream tick.
- Events emitted: `ready`, `user_turn_started`, `assistant_turn_started`,
  `assistant_delta`, `assistant_turn_finished{content}`, `idle`.
- Controls handled: `submit`, `interrupt`.
- TS: `packages/protocol` (typed events+controls **including** `tool_call_*` and
  `error` types, plus M4-control groundwork types; JSONL codec with
  partial/malformed handling; fd transport) and `packages/harness` (`Session`
  with the **basic** `ready` major-version gate).
- Verification harnesses: `proto-smoke.py`, `repl-regression.py`, C
  `protocol/emit` + `protocol/observer_e2e` tests.

## Decisions (locked; consistent with the parent spec + approved plan)

| Decision | Choice |
| --- | --- |
| Tool event source | `EV_TOOL_CALL_START` → `tool_call_started`; `EV_TOOL_CALL_END` → `tool_call_finished` (both on the existing `on_event` hook) |
| Tool event semantics | The **model's tool-call stream lifecycle** (call begun / args finalized), NOT tool *execution* outcome. `status` is `"ok"` for a normally-finalized call |
| Tool name on END | `EV_TOOL_CALL_END` carries only `id`; the emitter tracks `name` keyed by `id` from `EV_TOOL_CALL_START` |
| Error event | `EV_ERROR` → `error{message,turnId}` (turn-scoped → engine returns to `idle`); fatal/startup failure → child exits → harness observes fd-3 EOF |
| Version mismatch | Harden M3a's basic gate: typed failure + child teardown, covered by an e2e |
| `assistant_delta` | **Always-on** in M3 (ratify; no opt-in control). Record in `docs/protocol.md` |
| M4 controls | `status` / `new_conversation` / `copy_last_response` remain **typed groundwork only** (already done); NO engine behavior in M3 |

## Scope — the four widenings

### 1. Tool-call events end-to-end `[C + tests]`

Extend `emit_stream_event` (today: `EV_TEXT_DELTA` only) to also translate, on
the existing `agent.c` `on_event` hook:

- `EV_TOOL_CALL_START {id,name}` → `tool_call_started{turnId,name,callId}`.
- `EV_TOOL_CALL_END {id}` → `tool_call_finished{turnId,name,callId,status:"ok"}`.

Because `EV_TOOL_CALL_END` lacks `name`, `emit_state` keeps a small fixed-size
table of in-flight `{id → name}` entries: add on START, look up + clear on END
(supports parallel tool calls). `callId` is the event `id`. These interleave with
the lifecycle events exactly as the parent spec's byte example shows
(`assistant_turn_started` may recur across hax's inner model→tool→model loop).

**Semantics note (must be documented, not silently misleading):** these events
report the *model's* tool-call emission, not whether the tool *executed*
successfully. `status:"ok"` means "the call was fully formed." Reporting tool
*execution* outcome (the `ITEM_TOOL_RESULT`) is out of scope for M3 — a possible
future `tool_result` event or richer `status`.

### 2. `error` event end-to-end `[C + TS + tests]`

- Turn-scoped: on the `on_event` hook, `EV_ERROR {message}` →
  `error{message,turnId}`; the engine's existing error path then returns to
  `idle` (so the post-turn `assistant_turn_finished` + `idle` still fire). The
  harness surfaces it as a recoverable, turn-scoped error and may submit again.
- Fatal/startup: failures before/around engine readiness end the child; the
  harness observes EOF on fd 3 and reports a fatal session failure. Emitting an
  explicit `error{message}` here is best-effort (only when the emitter is already
  initialized) — EOF is the authoritative fatal signal.

### 3. Version-mismatch teardown hardening `[TS + tests]`

Beyond M3a's basic major-version assert: on mismatch, `Session.start()` rejects
with a typed `ProtocolVersionError`, kills the child, and leaves no orphaned
process or hanging iterator. Covered by an e2e that spawns a **fake engine** (a
tiny script passed via `Session.start({ binary })`) which emits a `ready` with an
unsupported major and then idles — asserting the harness refuses and tears down.

### 4. `assistant_delta` opt-in decision `[docs]`

Ratify **always-on** for M3 (streaming is cheap and the mock makes it
deterministic); record the decision in `docs/protocol.md`. An opt-in streaming
control, if ever wanted, is a later milestone — not M3.

## Engine seam details (grounded in hax source)

- `provider.h`: `EV_TOOL_CALL_START { const char *id; const char *name; }`,
  `EV_TOOL_CALL_END { const char *id; }`, `EV_ERROR { const char *message; int
  http_status; }`.
- All three already pass through `agent.c`'s `on_event` callback, where M3a added
  the single `emit_stream_event(g_emit, ev)` call — so M3b's tool/error work is
  **inside `emit.c`** (the translation), with no new `agent.c` hook points.
- This keeps the patch on the guardrail: the M3b C delta is confined to
  `emit.c`/`emit.h` (the `{id→name}` table + two new `case`s + the error `case`).

## Testing

- **Deterministic:** every test uses `HAX_PROVIDER=mock` (no LLM). The mock's
  backtick-argument path (e.g. submit ``run `ls` ``) yields a deterministic tool
  call; a slow `HAX_MOCK_SCRIPT` is available for timing-sensitive cases.
- **C (emitter unit) — REQUIRED for the error translation:** extend the
  `protocol/emit` unit test (`test_emit.c`, which already feeds `EV_TEXT_DELTA`
  to `emit_stream_event`) to also feed `EV_TOOL_CALL_START`, `EV_TOOL_CALL_END`,
  and **`EV_ERROR`**, asserting `emit_stream_event` writes well-formed
  `tool_call_started{name,callId}`, `tool_call_finished{name,callId,status:"ok"}`,
  and **`error{message,turnId}`** JSONL. This directly covers the C translation
  for every M3b event — so a missing or malformed `EV_ERROR`/tool `case` in
  `emit.c` fails a committed test regardless of whether the mock provider can
  emit those events. (This is the gate that makes "error end-to-end in C" real.)
- **C (engine):** a tool-turn test (extend `observer_e2e` or a sibling) driving
  the real binary over fds and asserting `tool_call_started` then
  `tool_call_finished{status:"ok"}` appear in order with matching `name`/`callId`,
  interleaved correctly with the lifecycle events; assert well-formed JSONL.
- **TS e2e:**
  - tool-turn: assert the `tool_call_started`/`tool_call_finished` events arrive
    with correct fields and ordering;
  - error: a fake-engine (or mock error path) run asserting an `error` event is
    surfaced turn-scoped and the session can continue / reports fatal on EOF;
  - version-mismatch: fake engine with a bad major → `ProtocolVersionError` +
    teardown.
- **Codec:** event/control round-trip already covers `tool_call_*` and `error`
  types (M3a `codec.test.ts`); extend only if fields change.
- **Regression (unchanged invariant):** the no-fd **interactive** REPL remains
  byte-for-byte identical vs a pre-patch baseline at the current synced base
  (`repl-regression.py`); M3b adds no `agent.c` REPL-path changes, so this must
  still pass.

## Done when

The **full enumerated M3 set** is verified:

- `ready`, `user_turn_started`, `assistant_turn_started`, `assistant_delta`,
  **`tool_call_started`**, **`tool_call_finished`**, `assistant_turn_finished{content}`,
  `idle`, plus controls `submit` and `interrupt`, flow over the fds under the
  **mock provider** (the mock's backtick path drives the tool events).
- **`error`** is verified through the **real C translation**: the required
  `emit.c` emitter unit test feeds `EV_ERROR` to `emit_stream_event` and asserts
  the `error{message,turnId}` JSONL (mock-independent), and the TS harness's
  turn-scoped/fatal error handling is exercised by the fake-engine e2e. Acceptance
  for `error` does **not** depend on the mock provider being able to emit
  `EV_ERROR` — but the C `EV_ERROR` translation MUST be covered by a committed
  test, not skipped.
- The version-mismatch teardown path is exercised by a committed test, and the
  no-fd interactive REPL is still byte-for-byte unaffected.

The M4 controls (`copy_last_response`, `new_conversation`, `status`) are
explicitly NOT required to function — only their documented groundwork (already
present) is in scope.

## Out of scope for M3b

- Tool *execution* outcome reporting (a `tool_result` event / execution `status`).
- M4 control behavior (`copy_last_response`, `new_conversation`, `status`),
  mount-mode chrome suppression, the ai-whisper adapter (M5), workflow
  integration (M6), and non-fd transports.
- Any new `agent.c` REPL-path change (the M3b C delta stays inside `emit.c`).

## Risks

| Risk | Mitigation |
| --- | --- |
| Mock provider can't emit `EV_ERROR` for an *engine-level* error test | The C `emit.c` error translation is covered directly by the **required emitter unit test** (feed `EV_ERROR` to `emit_stream_event` and assert the `error{message,turnId}` JSONL) — this does not depend on the mock emitting `EV_ERROR`. The TS error e2e additionally uses a fake-engine script (a few lines writing a JSONL `error` to fd 3) via `Session.start({ binary })` to exercise the harness's turn-scoped/fatal handling. The C test must NOT skip the `EV_ERROR` case. |
| Parallel tool calls collide in the `{id→name}` table | Fixed-size table sized to hax's max parallel calls; add on START, clear on END; on overflow, fall back to an empty name (still emits the event). |
| `status:"ok"` misread as execution success | Documented explicitly in `docs/protocol.md` and this spec; the event reflects call lifecycle, not execution. |
| M3b C change creeps beyond `emit.c` | Guardrail: tool/error translation lives in `emit.c`; if a hook in `agent.c`'s dispatch loop seems needed, stop — that's execution-outcome scope (out of scope). |
