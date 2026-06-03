# M3 — Protocol MVP implementation plan

- **Date:** 2026-06-03
- **Status:** ready for execution
- **Source spec:** `docs/superpowers/specs/2026-06-03-m3-protocol-mvp-design.md` (approved)
- **References:** `docs/protocol.md`, `docs/architecture.md`, `UPSTREAM.md`,
  `docs/superpowers/plans/2026-06-03-ai-ezio.md` (M3 section)
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/plans/` (this file is the synced mirror)

## Goal

Prove the harness can drive hax over JSONL on inherited fds with no scraping, via
an upstreamable `agent_observer` seam in hax + a thin downstream `emit.c` + TS
`protocol`/`harness`. Staged **M3a** (thin vertical slice) → **M3b** (widen to the
full M3 set). Each step is test-first and rides an existing hax seam; if the C
change exceeds the spec's guardrail, stop and reconsider.

## Ground rules (from the spec + AGENTS.md + UPSTREAM.md)

1. **Engine vs product:** the `agent_observer` seam is upstreamable hax C; the
   JSONL serialization, fd I/O, and control parsing live in downstream
   `src/protocol/emit.c`. Protocol schema/codec/transport and the session driver
   are TS in `packages/`.
2. **Keep the patch on the guardrail:** `agent_observer.{c,h}`, `emit.c` (+header),
   two CLI flags, ~5 observer invocation points + 1 `on_event` hook + the
   input-source swap + the tick control-read, one `meson.build` line. Anything
   beyond → stop.
3. **hax C style:** 4-space indent, spaces, snake_case, `struct foo` (no typedefs),
   `/* SPDX-License-Identifier: MIT */` header, `clang-format -i` every touched
   file (`make lint` must pass). **`clang-format` must be installed first**
   (`brew install clang-format`).
4. **Protocol is the contract:** update `docs/protocol.md` BEFORE coding any event
   shape change (Phase 0).
5. **No scraping; stdout/stderr stay human-only.** Protocol only active when fds
   are wired; the no-fd REPL must stay byte-for-byte unchanged.
6. **Submodule workflow:** the hax patch lands on the `vendor/hax` `emitter`
   branch; after building/testing, bump the submodule pointer in ai-ezio and
   commit (per UPSTREAM.md).

## Where the seams live (verified in hax source)

| Seam | Location | Use |
| --- | --- | --- |
| Stream events | `agent.c:375` `on_event()` (switch over `stream_event`) | hook deltas/tools/error |
| REPL loop | `agent.c:749` outer `for(;;)` | lifecycle emit points |
| Input read | `agent.c:752` `input_readline(input, prompt)` | `submit` input-source swap |
| User msg accepted | `agent.c:788` `agent_session_add_user` | `on_user_turn` |
| Model stream call | `agent.c:846` `p->stream(p,&ctx,model,on_event,&ec,agent_stream_tick,&r)` | `on_assistant_begin` before; tick reads control fd |
| Turn assembly | `turn.{c,h}`, `turn_take_items` | source of finalized assistant text for `on_turn_finished` |
| Session id | `session.c` (UUID shown in `--resume`) | `ready.sessionId` |
| Arg parsing | `main.c` getopt_long | `--protocol-fd` / `--control-fd` |
| Build | `vendor/hax/meson.build` | one source line for `emit.c` / observer |

---

## Phase 0 — Prerequisites (before any code)

1. **Install `clang-format`** (`brew install clang-format`); confirm `make lint`
   runs in `vendor/hax`.
2. **Update `docs/protocol.md`** to match the locked decisions: `turn_finished`
   cardinality = one per user turn; `content` = last assistant message (empty if
   tool-only); `assistant_delta` always-on in M3. Note `status`/`new_conversation`/
   `copy_last_response` as M4 (groundwork-only in M3).
3. **Update `UPSTREAM.md` + `docs/architecture.md`** to replace the "one file +
   2–3 lines" characterization with the accurate `agent_observer` seam + emitter
   description (per spec "Documentation updates required by M3").
4. **Create the working branch** in the submodule: ensure `vendor/hax` is on
   `emitter`; all C changes commit there.

**Done when:** `clang-format` available; the three docs reflect the M3 decisions;
`vendor/hax` is on `emitter`.

---

## Phase M3a — thin vertical slice

Event set: `ready`, `user_turn_started`, `assistant_turn_started`,
`assistant_delta`, `assistant_turn_finished{content}`, `idle`. Controls: `submit`,
`interrupt`. (Tool events + `error` are M3b.)

### Step 1 — CLI flags + fd plumbing (`main.c`)  [C]

- Add `--protocol-fd=<n>` / `--control-fd=<n>` to the getopt_long table; parse to
  `int` (default `-1`). Validate each with `fstat` (fail fast with a clear stderr
  message if the fd is invalid).
- Define `struct proto_io { int event_fd; int control_fd; };` (in a small header,
  e.g. `agent_observer.h` or a new `protocol/emit.h`) and thread it into
  `agent_run`.
- **Test:** `hax --protocol-fd=3 --control-fd=4` (with pipes) starts; without the
  flags, unchanged. *Risk: low.*

### Step 2 — `agent_observer` seam (header + registration + invocation)  [C, upstreamable]

- Add `src/agent_observer.h` exactly as the spec declares (`struct agent_observer`
  with `on_ready`/`on_user_turn`/`on_assistant_begin`/`on_turn_finished`/`on_idle`,
  all optional).
- Thread a `const struct agent_observer *obs` (nullable) into `agent_run`
  alongside `proto_io`. Add a tiny `#define OBS_CALL(obs, cb, ...)` helper that
  null-checks before calling.
- Generate a **per-user-turn id**: a monotonic counter in `agent_run`, formatted
  `t%zu`, assigned once when the user line is accepted and reused for every
  callback in that user turn.
- Invoke at the 5 points: `on_ready` before the outer loop (sessionId from
  `session.c`); `on_user_turn` after `agent_session_add_user` (`:788`);
  `on_assistant_begin` before `p->stream` (`:846`, can fire >1× per user turn);
  `on_turn_finished` after the inner tool-loop settles, passing the **last
  assistant message text** (read from the assembled items / session tail);
  `on_idle` at the top of the outer loop.
- **Test (C):** a stub observer in `tests/` records call order for a mock turn;
  assert `ready → user_turn → assistant_begin → turn_finished → idle` and that
  `on_turn_finished` content equals the mock's final text. *Risk: medium — the
  `on_turn_finished` content source is the one place reaching toward turn/session
  state; keep it to a read of the just-finalized assistant item.*

### Step 3 — `emit.c` observer impl + `ready` + lifecycle JSONL  [C, downstream]

- New `src/protocol/emit.c` (+ `emit.h`). A jansson JSONL writer:
  `emit_line(int fd, json_t *obj)` → `json_dumps(obj, JSON_COMPACT)` + `\n`,
  `write()` with partial-write/EINTR retry.
- An `agent_observer` whose callbacks build the JSONL objects: `ready`
  (`sessionId`, `protocol` = compile-time `AI_EZIO_PROTOCOL_VERSION` "0.1.0",
  `haxBaseCommit` = compile-time macro, "unknown" in dev), `user_turn_started`,
  `assistant_turn_started`, `assistant_turn_finished{content}`, `idle`.
- A constructor `emit_observer_init(struct emit_state *, int event_fd, int
  control_fd)` returning a `struct agent_observer` bound to the state; `main.c`
  wires it when `--protocol-fd` is set.
- One `meson.build` line adds `src/protocol/emit.c` (and passes
  `-DAI_EZIO_HAX_COMMIT=...` for the downstream build).
- **Test (C):** drive a mock turn with the real emitter writing to a pipe; read
  the pipe and assert each line parses as JSON with the expected `type`/fields.
  *Risk: low.*

### Step 4 — `on_event` hook for `assistant_delta`  [C]

- One added call at the end of `agent.c:on_event` →
  `emit_stream_event(ec->emit, ev)`; for M3a translate only `EV_TEXT_DELTA` →
  `assistant_delta{turnId,text}`. Gated on `event_fd >= 0`. Purely additive; the
  existing rendering switch is untouched.
- **Test (C):** mock turn produces `assistant_delta` lines on the pipe in order,
  interleaved correctly with lifecycle lines. *Risk: low.*

### Step 5 — `submit` input-source swap  [C]

- At `agent.c:752`, when `control_fd >= 0`, call `proto_read_submit(control_fd)`
  (in `emit.c`) instead of `input_readline`: blocking read of one JSONL line,
  parse `{type:"submit",text}` → return `strdup(text)` as the "line"; on EOF
  return NULL (clean shutdown); ignore unknown control types for the slice (log
  to stderr, keep reading). The no-fd path keeps `input_readline` exactly.
- **Test:** harness sends `submit` → hax runs the turn (covered by the TS e2e).
  *Risk: medium — gate strictly; the regression test (Step 9) proves the no-fd
  path is unchanged.*

### Step 6 — `interrupt` via stream tick  [C]

- Extend the tick path used at `agent.c:846` (`agent_stream_tick`): in addition to
  Esc/idle, when `control_fd >= 0` do a **non-blocking** read of the control fd,
  buffer partial lines, and if a `{type:"interrupt"}` line completes, return
  non-zero (abort, exactly like Esc) → engine returns to `idle`.
- Keep the partial-line buffer in `emit_state` (a control may straddle ticks).
- **Test:** harness submits, then sends `interrupt` mid-turn → turn aborts → next
  event is `idle` (TS e2e). *Risk: medium — non-blocking read + buffering.*

### Step 7 — `packages/protocol` (codec + fd transport)  [TS]

- Replace the M1 placeholder with: TS types for the M3a events + `submit`/
  `interrupt` controls; a JSONL codec (`encode(obj)→line`, `decode(buffer)`
  splitting on `\n`, buffering partial lines, surfacing malformed lines as a typed
  protocol error); a `Transport` interface (`read(): AsyncIterable<Event>`,
  `send(control): void`); an **fd transport** over two streams; the
  `PROTOCOL_VERSION` constant + `isProtocolCompatible` (already present).
- **Tests (TS, Vitest):** round-trip every event/control; partial-line buffering
  (a line split across two chunks); malformed-line surfacing; version-major gate.
  *Risk: low-med.*

### Step 8 — `packages/harness` (spawn + session state machine)  [TS]

- Spawn the resolved hax binary with `--protocol-fd=3 --control-fd=4 -p`? No —
  mounted/headless: spawn with `stdio:['inherit','inherit','inherit', eventPipe,
  controlPipe]` and `HAX_PROVIDER` passthrough; child dies with parent.
- A `Session` driving the state machine `starting → idle → user_turn →
  assistant_turn → idle`; reads the fd-3 transport, applies the `ready` version
  gate (refuse on major mismatch + teardown), exposes `submitAndWait(text) →
  content`, `interrupt()`, and event subscription; treats `idle` as the only safe
  point to submit.
- **Tests (TS):** state-machine transitions with a scripted transport (no child);
  version-gate refusal. *Risk: low.*

### Step 9 — e2e + regression + build integration  [TS + C]

- **e2e (TS):** spawn the dev hax (`AI_EZIO_HAX_BIN`/dev fallback) with
  `HAX_PROVIDER=mock`; assert the full M3a sequence over fd 3, the `content`
  handback, and the `interrupt` path (submit a long mock turn, interrupt, expect
  `idle`).
- **Regression — interactive REPL, byte-for-byte (the spec's exact contract):**
  the patch modifies the **interactive** `agent_run` path (input-source swap,
  tick), NOT the `-p` one-shot path — so the regression MUST drive the
  *interactive* REPL, not `-p`. Procedure:
  1. Build a **pre-patch baseline** hax from the `emitter` branch's parent (the
     base commit `8fd139b`, i.e. `hax-upstream/main`) into a separate build dir
     (`build-baseline/`), and the patched hax into `build/`.
  2. Drive **both** binaries through a **pseudo-terminal (PTY)** with the *same*
     scripted interactive session under `HAX_PROVIDER=mock` and **no protocol
     fds** — e.g. type a prompt, receive the mock reply, then `/new`, then EOF —
     capturing each binary's full stdout (prompt chrome, ANSI, block separators,
     the rendered answer).
  3. Assert the two stdout byte streams are **identical** (byte-for-byte). This
     exercises the exact human-REPL rendering the spec protects.
  - *Determinism note:* use a mock script that completes each turn instantly so
    the time-based busy spinner never arms (no wall-clock-variant frames); if any
    known time-variant escape sequence still appears, strip exactly that
    sequence from both captures before comparing and document the normalization.
    Both binaries run identical render code on the no-fd path, so given identical
    PTY input they must produce identical bytes.
  - Also assert the patched binary writes **nothing** to fd 3 when no
    `--protocol-fd` is given (no protocol leakage on the human path).
  - The `-p` one-shot stdout check MAY be kept as a cheap extra guard, but it
    does NOT satisfy this requirement on its own.
- **Build:** `meson compile`/`meson test` green on `emitter`; `make lint` clean;
  bump the `vendor/hax` submodule pointer in ai-ezio.

**M3a done when (spec):** with `HAX_PROVIDER=mock`, the harness sends one `submit`
over fd 4 and observes `ready → user_turn_started → assistant_turn_started →
assistant_delta… → assistant_turn_finished{content} → idle` over fd 3, reading
`content` as the handback with no stdout parsing; `interrupt` aborts a live turn
→ `idle`; and with no fds wired the human REPL output is byte-for-byte unchanged.

---

## Phase M3b — widen to the full M3 set

Same mechanism; only widen coverage. **No rewrite.**

1. **Tool events** [C]: in the `on_event` hook, translate `EV_TOOL_CALL_START` →
   `tool_call_started{turnId,name,callId}` and `EV_TOOL_CALL_END` →
   `tool_call_finished{turnId,name,callId,status:"ok"}`. *(callId from the
   event's id; name tracked from start.)*
2. **Error end-to-end** [C]: `EV_ERROR` → `error{message,turnId}` (turn-scoped →
   engine returns to `idle`); startup/fatal → `error{message}` then session ends
   (harness sees fd-3 EOF).
3. **Version-mismatch teardown hardening** [TS]: beyond M3a's basic assert — on
   major mismatch, emit a clear harness error, kill the child, surface a typed
   failure to the caller; e2e covers it (spawn a stub that announces a bad major).
4. **Controls groundwork only** [TS + C]: add `status`/`new_conversation`/
   `copy_last_response` to the protocol **types** and document them as M4; do NOT
   implement their engine behavior. (Keeps the M3/M4 boundary the reviewer fixed.)
5. **`assistant_delta` opt-in decision** [docs]: record the call (default
   always-on) in `docs/protocol.md`; implement opt-in only if decided.
6. **Tests:** extend the e2e to a tool-calling mock turn (backtick arg →
   `tool_call_started/finished` interleaved); add the error-path and
   version-mismatch e2e; widen codec tests to the new event/control types.

**M3b done when (spec):** the **explicit M3 set** flows over the fds under the mock
provider — `ready`, `user_turn_started`, `assistant_turn_started`,
`assistant_delta`, `tool_call_started`, `tool_call_finished`,
`assistant_turn_finished{content}`, `error`, `idle`, plus `submit` and
`interrupt` — version-mismatch teardown exercised, human REPL byte-for-byte
unaffected when the protocol is off. The M4 controls are NOT required to function;
only their documented groundwork is in scope.

---

## File inventory

**hax (`vendor/hax`, `emitter` branch):**
- New: `src/agent_observer.h` (seam, upstreamable); `src/protocol/emit.c` +
  `src/protocol/emit.h` (downstream); a C test under `tests/` (+ `tests/meson.build`
  entry).
- Edited: `main.c` (flags + plumbing), `agent.c` (~5 observer calls + 1 on_event
  hook + input swap + tick control-read), `meson.build` (one source line + the
  commit define).

**ai-ezio TS (`packages/`):**
- `packages/protocol/src`: `events.ts`, `controls.ts`, `codec.ts`,
  `transport.ts`, `transport-fd.ts`, `version.ts` (+ tests).
- `packages/harness/src`: `spawn.ts`, `session.ts`, `state-machine.ts` (+ tests),
  exported from `index.ts`.
- `packages/harness` e2e test; submodule pointer bump committed in ai-ezio.

**Docs (Phase 0):** `docs/protocol.md`, `UPSTREAM.md`, `docs/architecture.md`.

## Testing strategy (all deterministic)

- **Engine (C):** `meson test -C vendor/hax/build` — observer call-order test +
  emitter JSONL well-formedness under `HAX_PROVIDER=mock`.
- **TS units:** `pnpm -r test` — codec (round-trip/partial/malformed), version
  gate, harness state machine.
- **e2e:** harness ↔ dev hax over fds with mock — full sequence, `content`,
  interrupt, error, version-mismatch.
- **Regression:** the **interactive** human REPL (not `-p`) is byte-for-byte
  unchanged with no fds wired — patched vs pre-patch baseline binary driven
  through a PTY with the same scripted mock session (see Step 9 for the exact
  procedure + determinism note). This is the layer the patch actually touches.
- **Per-step TDD:** write the failing test first for each event, control, and
  transition.

## Verification commands

```sh
brew install clang-format                         # Phase 0 prerequisite
make -C vendor/hax lint                            # hax C style gate
# pre-patch baseline build for the interactive-REPL regression (base commit):
git -C vendor/hax worktree add ../hax-baseline 8fd139b
meson setup vendor/hax-baseline/build-baseline vendor/hax-baseline
meson compile -C vendor/hax-baseline/build-baseline   # baseline hax (pre-emitter)
meson compile -C vendor/hax/build                  # build patched engine
meson test -C vendor/hax/build --print-errorlogs   # engine tests (incl. PTY regression)
pnpm -r build && pnpm -r test                      # TS build + unit/e2e
pnpm run smoke:install                             # M1 gate still green
```

The PTY-driven interactive regression compares `vendor/hax/build/hax` (patched)
against the baseline binary built above; both run with `HAX_PROVIDER=mock` and no
protocol fds.

## Risks & mitigations (from the spec, made actionable)

| Risk | Mitigation in this plan |
| --- | --- |
| `on_turn_finished` content reaches into turn/session state | Keep it to a single read of the just-finalized assistant item at one call site; C test asserts content == mock final text. |
| Input-source swap disturbs the human REPL | Strict `control_fd >= 0` gate; Step 9 PTY-driven **interactive** REPL regression — patched vs pre-patch baseline binary, byte-for-byte (not the `-p` one-shot, which the patch doesn't touch). |
| Interrupt partial-line races across ticks | Non-blocking read + partial-line buffer in `emit_state`; e2e interrupts mid-turn. |
| Patch creeps past the guardrail | File inventory is the budget; exceeding it is the stop signal (spec guardrail). |
| Upstream declines the observer PR | Seam stays isolated on `emitter`; maintain downstream; fork is last resort. |
| Node fd inheritance ordering | Explicit `stdio` array (indices 3/4); e2e spawn test covers it. |

## Suggested execution order (summary)

Phase 0 (docs + clang-format) → M3a Steps 1–9 (flags → observer seam → emitter →
delta hook → submit → interrupt → TS protocol → TS harness → e2e/regression) →
M3b (tool events → error → version-mismatch hardening → M4 controls groundwork →
delta opt-in decision → widened tests). Land C on the `emitter` branch and bump
the submodule pointer; keep each step test-first and on its existing seam.
