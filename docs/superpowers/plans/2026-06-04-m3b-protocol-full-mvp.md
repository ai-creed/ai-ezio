# M3b — Protocol full-MVP implementation plan

- **Date:** 2026-06-04
- **Status:** ready for execution
- **Source spec:** `docs/superpowers/specs/2026-06-04-m3b-protocol-full-mvp-design.md` (approved)
- **Parent:** `docs/superpowers/specs/2026-06-03-m3-protocol-mvp-design.md`,
  `docs/superpowers/plans/2026-06-03-m3-protocol-mvp.md` (Phase M3b)
- **References:** `docs/protocol.md`, `UPSTREAM.md`
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/plans/` (this file is the synced mirror)

## Goal

Widen the M3a slice to the full M3 set with the **same** mechanism — no rewrite.
Add `tool_call_started`/`tool_call_finished` and `error` to the downstream
emitter (translation only, inside `emit.c`, on the existing `on_event` hook),
harden the harness version-mismatch teardown, and ratify the `assistant_delta`
always-on decision. Each step is test-first; the C delta stays confined to
`emit.c`/`emit.h` (guardrail).

## Ground rules (from the spec + AGENTS.md + UPSTREAM.md)

1. **Guardrail:** the entire M3b C change lives in `emit.c`/`emit.h`. No new
   `agent.c` hook points — tool/error `stream_event`s already flow through the
   single `emit_stream_event(g_emit, ev)` call M3a added to `on_event`. If a hook
   into `agent.c`'s dispatch loop seems necessary, **stop** — that's tool
   *execution* outcome, which is out of scope.
2. **C style:** hax rules — 4-space indent, snake_case, `struct foo`, SPDX header,
   `clang-format -i` every touched file; `make lint` must pass.
3. **Error must be verified through the real C translation** — a committed
   emitter unit test feeds `EV_ERROR` (and tool events) to `emit_stream_event`;
   acceptance does NOT depend on the mock emitting `EV_ERROR`.
4. **No-fd interactive REPL stays byte-for-byte unchanged** — M3b adds no
   `agent.c` REPL-path change, so `repl-regression.py` must still pass.
5. **Submodule workflow:** C changes land on the `vendor/hax` `emitter` branch
   (currently rebased onto upstream `e2a7eaf`); push to the fork
   (`ai-creed/hax`), then bump the submodule pointer in ai-ezio.

## Current code state (what M3b edits)

- `vendor/hax/src/protocol/emit.c` — `emit_stream_event` has only an
  `EV_TEXT_DELTA` case + `default`. `emit_state` (in `emit.h`) holds
  `event_fd`, `control_fd`, `turn_id[32]`, the control-fd buffer. Stream events
  are stamped with `es->turn_id` (set by `emit_set_turn`).
- `vendor/hax/tests/protocol/test_emit.c` — feeds `EV_TEXT_DELTA`; asserts JSONL.
- `vendor/hax/tests/protocol/test_observer_e2e.c` — drives the real binary, mock
  text turn, asserts the lifecycle order.
- `packages/protocol` — `events.ts` already types `ToolCallStarted/Finished` and
  `Error`; `controls.ts` has M4 groundwork types; codec round-trips them.
- `packages/harness/src/session.ts` — `Session` with the **basic** `ready`
  major-version gate (`isProtocolCompatible` → `close()` + `ProtocolVersionError`)
  and `onEvent` tee + `submit`/`waitForEvent`/`submitAndWait`/`interrupt`. Today
  `submitAndWait`/`waitForEvent` **throw** on an `error` event.
- `docs/protocol.md` — already records the M3 decisions incl. `assistant_delta`
  always-on (added in M3a Phase 0); M3b confirms + adds the tool-status semantic.

---

## Phase 0 — prerequisites

1. Confirm `vendor/hax` is on `emitter` (rebased onto `e2a7eaf`) and
   `clang-format` is installed; `make -C vendor/hax lint` runs clean on the
   current tree.
2. Confirm `docs/protocol.md` already states `assistant_delta` is always-on in
   M3; if the wording is missing, add it (spec widening 4). Add a one-line
   tool-status semantic note (status = call lifecycle, not execution).

**Done when:** branch/toolchain confirmed; protocol.md reflects the delta + tool
semantics decisions.

---

## Step 1 — Tool-call events in `emit.c` (`[C]`, test-first)

1. **Test first** (`tests/protocol/test_emit.c`): feed `emit_stream_event` an
   `EV_TOOL_CALL_START {id:"c1",name:"bash"}` then `EV_TOOL_CALL_END {id:"c1"}`
   (after `emit_set_turn(&es,"t1")`); read the pipe and assert two well-formed
   lines: `tool_call_started{turnId:"t1",name:"bash",callId:"c1"}` and
   `tool_call_finished{turnId:"t1",name:"bash",callId:"c1",status:"ok"}`. Run →
   red (no cases yet).
2. **`emit.h`:** add a small fixed-size in-flight table to `emit_state` — e.g.
   `struct { char id[64]; char name[64]; } pending_tools[16]; size_t n_pending;`
   (16 is comfortably above hax's parallel-call count).
3. **`emit.c`:** in `emit_stream_event`, add:
   - `case EV_TOOL_CALL_START`: record `{id→name}` in the table (drop silently if
     full), emit `tool_call_started{turnId,name,callId}`.
   - `case EV_TOOL_CALL_END`: look up `name` by `id` (empty string if not found),
     clear the entry, emit `tool_call_finished{turnId,name,callId,status:"ok"}`.
   - `EV_TOOL_CALL_DELTA` stays in `default` (no event).
4. `clang-format -i`; run → green.

**Risk:** parallel-call table overflow → fall back to an empty name; still emit.

---

## Step 2 — `error` event in `emit.c` (`[C]`, test-first)

1. **Test first** (`test_emit.c`): feed `EV_ERROR {message:"boom"}` (with
   `turn_id` set) and assert `error{message:"boom",turnId:"t1"}` JSONL. Run → red.
2. **`emit.c`:** add `case EV_ERROR`: emit
   `error{message,turnId}` (stamp `es->turn_id`; message from
   `ev->u.error.message`, empty if NULL). No `agent.c` change — the engine's
   existing EV_ERROR path already returns the turn to `idle`, so
   `assistant_turn_finished` + `idle` still follow.
3. `clang-format -i`; run → green.

**Done when:** `test_emit.c` covers `EV_TEXT_DELTA`, `EV_TOOL_CALL_START/END`, and
`EV_ERROR` translations — the required C error-translation gate.

---

## Step 3 — engine-level tool-turn C test (`[C]`)

1. Add `tests/protocol/test_observer_tool_e2e.c` (sibling of
   `test_observer_e2e.c`): spawn the real hax binary with the fds wired and
   `HAX_PROVIDER=mock`, submit a backtick-arg prompt (e.g.
   `{"type":"submit","text":"run \`ls\`"}`) so the mock emits a bash tool call;
   read fd 3 and assert the ordered subsequence includes `tool_call_started`
   then `tool_call_finished{status:"ok"}` with matching `name`/`callId`,
   interleaved with the lifecycle events, ending at `idle`; assert well-formed
   JSONL. Register in `tests/meson.build` (pass `hax_exe` via `args`/`depends`).
2. Confirm the mock's backtick path actually produces an `EV_TOOL_CALL_*` stream
   under the protocol fds (verify by hand once); if the exact trigger differs,
   adjust the submit text to a known mock tool-call trigger.

**Done when:** `meson test` includes a passing real-binary tool-turn test.

---

## Step 4 — harness error handling + version-mismatch hardening (`[TS]`, test-first)

1. **Turn-scoped error surfacing** (`packages/harness/src/session.ts`): today
   `submitAndWait` throws immediately on an `error` event, leaving the trailing
   `assistant_turn_finished`/`idle` unconsumed (which would corrupt the next
   turn). Change it to **drain to `idle`** when an `error` arrives, then reject
   with a typed `TurnError(message, turnId)` — so the session settles at a clean
   `idle` boundary and a subsequent `submitAndWait` works. Export `TurnError`.
   (The `onEvent` tee still surfaces the raw `error` event for observers.)
2. **Version-mismatch hardening:** ensure `start()` on a bad major rejects with
   `ProtocolVersionError`, calls `close()` (control-stream end + `child.kill()`),
   and the event pump terminates (no hanging async iterator). Add a guard so a
   double `close()` is safe.
3. **Fatal EOF handling:** when fd 3 reaches EOF (engine exited) while the harness
   is waiting — either during `start()` before `ready`, or mid-turn inside
   `submitAndWait`/`waitForEvent` — the harness must reject with a typed
   `EngineExitedError` (a *fatal* session failure, distinct from a turn-scoped
   `TurnError`). Today `next()` resolves `null` on end and the waiters throw a
   generic `Error("engine ended …")`; replace those with `EngineExitedError` so
   fatal EOF is a clear, typed signal. EOF is authoritative: no further submits
   are valid after it. Export `EngineExitedError`.
4. **Unit tests** (no real engine): with a scripted/fake transport, assert (a) the
   state machine drains-to-idle-then-throws `TurnError`, (b) the version gate
   rejects + tears down, and (c) an fd-3 EOF mid-wait rejects with
   `EngineExitedError`.

**Done when:** harness unit tests cover the turn-scoped-error drain, the
version-mismatch teardown, and the fatal-EOF `EngineExitedError` path.

---

## Step 5 — TS e2e: tool-turn, error, fatal-EOF, version-mismatch (`[TS]`)

In `packages/harness/src/session.e2e.test.ts` (and a small fake-engine helper):

1. **Tool-turn e2e** (real hax, mock backtick): record events via `onEvent`,
   assert `tool_call_started`/`tool_call_finished` arrive with correct
   `name`/`callId` and ordering relative to the lifecycle events.
2. **Fake-engine helper:** a tiny Node script (written to a temp file, passed as
   `Session.start({ binary })`) that writes canned JSONL to fd 3 and reads fd 4.
   Canned behaviors, each a distinct test case:
   - **error engine (turn-scoped):** emit `ready`(good major); on a `submit`, emit
     `user_turn_started → assistant_turn_started → error → assistant_turn_finished
     → idle`. Assert `submitAndWait` rejects with `TurnError` AND a subsequent
     `submitAndWait` (second canned turn) succeeds (session still usable);
   - **fatal-EOF engine:** emit `ready`(good major); on the first `submit`, emit
     `user_turn_started` then **exit / close fd 3** (no `idle`). Assert
     `submitAndWait` rejects with the typed `EngineExitedError` (fatal, NOT
     `TurnError`) and the session is unusable afterward. Also cover EOF *before*
     `ready` (engine exits at startup) → `start()` rejects with
     `EngineExitedError`. This is the spec's authoritative fd-3 EOF fatal signal,
     kept distinct from the bad-major case below;
   - **bad-major engine:** emit `ready` with `protocol:"9.9.9"` then idle. Assert
     `start()` rejects with `ProtocolVersionError` and the child is reaped.
3. The fake engine runs under Node (`process.execPath`) so no compiler needed and
   it's deterministic.

**Done when:** all four e2e cases pass under Vitest — tool-turn, turn-scoped
error, fatal EOF (`EngineExitedError`), and bad-major version mismatch.

---

## Step 6 — docs (`[docs]`)

1. `docs/protocol.md`: confirm `assistant_delta` always-on is recorded (add if
   missing); add the tool-call status semantic (`status:"ok"` = the model's call
   was fully formed, NOT tool execution outcome); confirm `error{message,turnId}`
   is documented.
2. No M4-control behavior — keep `status`/`new_conversation`/`copy_last_response`
   documented as M4.

---

## Step 7 — verification, submodule bump, commit

1. **Build + lint (C):** `meson compile -C vendor/hax/build`,
   `meson test -C vendor/hax/build` (incl. `protocol/emit`,
   `protocol/observer_e2e`, the new tool-turn test), `make -C vendor/hax lint`.
2. **TS:** `pnpm -r build && pnpm -r test` (codec, harness units incl. the
   fatal-EOF unit, and the four new e2e cases: tool-turn, turn-scoped error,
   fatal EOF, bad-major).
3. **Smoke + regression:** `python3 scripts/proto-smoke.py` (optionally extend
   with a tool phase); `python3 scripts/repl-regression.py <e2a7eaf-baseline>
   vendor/hax/build/hax` byte-for-byte PASS.
4. **Submodule:** commit the hax changes on `emitter`, push to `ai-creed/hax`,
   bump the `vendor/hax` pointer in ai-ezio.
5. **Commit** the ai-ezio side (submodule bump + TS + docs + any script changes).

**M3b done when (spec):** the full enumerated M3 set is verified — lifecycle +
tool events + `submit`/`interrupt` over fds under mock; `error` via the C
emitter unit test + the TS turn-scoped fake-engine e2e; **fatal fd-3 EOF**
surfaced as `EngineExitedError` by a committed test; version-mismatch teardown by
a committed test; no-fd interactive REPL still byte-for-byte unchanged.

## File inventory (the guardrail budget)

**hax (`vendor/hax`, `emitter` branch):**
- Edited: `src/protocol/emit.h` (the `{id→name}` table), `src/protocol/emit.c`
  (tool START/END + error `case`s), `tests/protocol/test_emit.c` (tool + error
  assertions), `tests/meson.build` (new test registration).
- New: `tests/protocol/test_observer_tool_e2e.c`.
- **NOT touched:** `agent.c`, `main.c`, `agent_core.h` (guardrail — if these need
  editing, stop and reconsider).

**ai-ezio (`packages/`, docs):**
- `packages/harness/src/session.ts` (`TurnError` + drain-to-idle, `EngineExitedError`
  for fatal EOF, version teardown), `index.ts` (export `TurnError` +
  `EngineExitedError`), `session.e2e.test.ts` (+ fake-engine
  helper), possibly a `session.test.ts` unit for the drain/teardown.
- `docs/protocol.md`; submodule pointer bump.

## Testing strategy (all deterministic, `HAX_PROVIDER=mock`)

- **C emitter unit** (`test_emit.c`): the required gate — `EV_TEXT_DELTA`,
  `EV_TOOL_CALL_START/END`, `EV_ERROR` → JSONL.
- **C engine** (`observer_e2e` + new tool-turn): real-binary lifecycle + tool.
- **TS units:** drain-to-idle `TurnError`; version-mismatch teardown; fatal-EOF
  `EngineExitedError`.
- **TS e2e:** tool-turn (real hax); turn-scoped error, fatal EOF, and bad-major
  (fake engine).
- **Regression:** no-fd interactive REPL byte-for-byte unchanged.
- **Per-step TDD:** failing test first for each new `case`/behavior.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Mock can't emit `EV_ERROR` over real fds | C emitter unit test feeds `EV_ERROR` directly (mock-independent); TS error e2e uses a fake engine. The C `EV_ERROR` case must not be skipped. |
| Backtick mock trigger doesn't fire a tool call under fds | Verify the exact mock tool-call trigger by hand; adjust the submit text; fall back to a `HAX_MOCK_SCRIPT` that scripts a tool call if needed. |
| `submitAndWait` throw leaves events unconsumed → corrupts next turn | Drain to `idle` before throwing `TurnError`; covered by the harness unit + the error e2e's "subsequent turn succeeds" assertion. |
| Parallel tool-call `{id→name}` overflow | Fixed 16-entry table; overflow → empty name, still emits. |
| C change creeps into `agent.c` | File inventory is the budget; `agent.c` is explicitly off-limits for M3b. |

## Execution order (summary)

Phase 0 → Step 1 (tool events, C, TDD) → Step 2 (error, C, TDD) → Step 3 (engine
tool-turn C test) → Step 4 (harness error + version hardening, TS, TDD) → Step 5
(TS e2e: tool/error/fatal-EOF/bad-major) → Step 6 (docs) → Step 7 (verify, push fork, bump
submodule, commit). Keep every step test-first and the C delta inside `emit.c`.
