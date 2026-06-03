# M3 — Protocol MVP design spec

- **Date:** 2026-06-03
- **Status:** approved (brainstorm), pre-implementation
- **Milestone:** M3 (Protocol MVP, includes the first hax C patch)
- **Parent spec:** `docs/superpowers/specs/2026-06-03-ai-ezio-design.md`
- **References:** `docs/architecture.md`, `docs/protocol.md`, `UPSTREAM.md`,
  `docs/milestones.md`, `docs/superpowers/plans/2026-06-03-ai-ezio.md`
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/specs/` (this file is the synced mirror)

## Purpose

M3 is the **feasibility milestone**: prove that the TS harness can drive the hax
engine over an explicit JSONL protocol on inherited file descriptors — no TUI
scraping — and that the required hax change is a clean, upstreamable seam rather
than a sprawling fork. If M3 lands cleanly, ai-ezio's whole premise (a hax engine
+ a TS harness over a machine protocol) is validated and the later milestones
(mounted mode, adapter, workflow integration) can be built on it.

## Key finding that shaped this design

hax exposes per-stream events through a stable seam — the agent's `on_event`
callback (`agent.c`), fed by each provider's `stream_event` (`provider.h`). But
the **agent-loop lifecycle** (engine ready, a user turn accepted, a turn
finished with its authoritative final text, engine idle) has **no public seam**
today. Earlier docs implied the emitter was "one file + 2–3 lines"; in reality
the lifecycle gap must be filled. Rather than have downstream code peek into
hax's `session`/`turn` internals (fragile, non-upstreamable), we **add the
missing seam to hax** as a general-purpose `agent_observer` interface and keep
the JSONL/transport product code downstream.

## Decisions (locked in brainstorm)

| Decision | Choice |
| --- | --- |
| Lifecycle mechanism | New upstreamable `struct agent_observer` seam in hax |
| Stream events (deltas/tools/error) | Reuse the existing `stream_cb`/`on_event` seam |
| Handback `content` source | hax passes its own finalized assistant text via `on_turn_finished` |
| `turn_finished` cardinality | One per **user** turn (final answer); intermediate prose via deltas |
| `assistant_delta` | Always-on in M3; opt-in revisited in M3b/M4 |
| Mode flag | No `--mount-mode` in M3; presence of `--control-fd` drives headless input. Chrome suppression is M4 |
| Transport | Inherited fds (fd 3 events, fd 4 controls) behind a pluggable transport interface |
| Provider for tests | `HAX_PROVIDER=mock` (deterministic, no LLM) |
| Staging | M3a thin vertical slice → M3b full MVP, same mechanism throughout |

## Architecture

Three layers with one clean boundary:

```
   hax (C, upstreamable)              ai-ezio downstream (C)        ai-ezio harness (TS)
 ┌──────────────────────────┐      ┌──────────────────────┐      ┌─────────────────────┐
 │ stream_cb / on_event ────┼──┐   │ emit.c               │      │ packages/protocol    │
 │  (deltas, tools, error)  │  ├──►│  observer impl:      │─fd3─►│  codec + fd transport│
 │ agent_observer (NEW) ────┼──┘   │  events → JSONL      │◄fd4──│ packages/harness     │
 │  (ready/user/finish/idle)│      │  control fd → input  │      │  session/turn API    │
 └──────────────────────────┘      └──────────────────────┘      └─────────────────────┘
        stdout/stderr (fd 1/2) stay human-only — REPL chrome never mixes with protocol
```

- **Upstreamable in hax:** the `agent_observer` seam + `--protocol-fd` /
  `--control-fd` flags. Justified as general embedding/automation/observability
  support — mirrors hax's existing `struct provider` and `struct tool` seams.
- **Downstream in hax (ai-ezio's patch):** `src/protocol/emit.c` (+ header) —
  implements `agent_observer`, serializes JSONL to the event fd, reads/parses
  controls from the control fd. Plus one `meson.build` line.
- **TS:** `packages/protocol` (schema + codec + fd transport) and a minimal
  `packages/harness` session driver.

### The hax `agent_observer` seam (new, upstreamable)

```c
/* agent_observer.h — optional lifecycle hooks for embedding/automation.
 * Every callback optional (NULL = ignored). Pure notifications fired at
 * well-defined points in the agent loop; must not block. */
struct agent_observer {
    void *user;
    void (*on_ready)(void *user, const char *session_id);
    void (*on_user_turn)(void *user, const char *turn_id, const char *text);
    void (*on_assistant_begin)(void *user, const char *turn_id);
    void (*on_turn_finished)(void *user, const char *turn_id, const char *content);
    void (*on_idle)(void *user);
};
```

- Registered once on the agent (analogous to how the stream callback is wired).
- Invoked at ~5 existing points in `agent_run`: after init (`on_ready`), after
  the user line is accepted (`on_user_turn`), before each model stream
  (`on_assistant_begin`), after the inner tool-loop settles with the final
  assistant text (`on_turn_finished`), and at the top of the loop before input
  (`on_idle`).
- `on_turn_finished` receives hax's **own finalized assistant text** as a
  parameter — authoritative content, zero coupling to internal memory layout.
  Specifically `content` is the **last assistant message of the user turn** (the
  final answer the user reads); empty string if the turn produced no assistant
  text (e.g. a tool-only turn). Intermediate prose across the inner loop remains
  available to consumers via `assistant_delta`.

### Stream events (existing seam, reused)

`assistant_delta` (EV_TEXT_DELTA), `tool_call_started` / `tool_call_finished`
(EV_TOOL_CALL_START / END), and `error` (EV_ERROR) are emitted from a single
added call inside the agent's existing `on_event` callback, gated on the event
fd being set. No new surface there.

### Downstream emitter (`src/protocol/emit.c`)

- Implements `agent_observer`; each callback → one compact JSONL object written
  to the event fd (`json_dumps` via jansson + `\n`; partial-write/EINTR-safe).
- Translates the relevant `stream_event`s (from the `on_event` hook) to JSONL.
- Reads the control fd: blocking read for `submit` at the input-source swap;
  non-blocking poll for `interrupt` from the stream tick. Buffers partial lines.
- Emits `ready` once with `sessionId`, `protocol` version, and `haxBaseCommit`.

### CLI flags + fd plumbing (`main.c`)

- `--protocol-fd=<n>` (events out) and `--control-fd=<n>` (controls in).
- Validated with `fstat`; threaded into `agent_run` via a small `struct proto_io`.
- Absent ⇒ no protocol activity; the human REPL path is untouched.

### TS `packages/protocol`

- TypeScript types for every M3 event and control (per `docs/protocol.md`).
- Codec: JSONL encode/decode, UTF-8, `\n`-framed, with partial-line buffering on
  read and explicit malformed-line surfacing.
- Transport interface (`read(): AsyncIterable<Event>`, `send(control): void`);
  the **fd transport** is the first implementation. Wire format is identical
  across transports, so a socket/stdio transport can be added later untouched.
- Protocol version constant + a `ready.protocol` major-compatibility check.

### TS `packages/harness`

- Spawns hax with the event/control fds wired (`stdio:['inherit','inherit',
  'inherit', eventPipe, controlPipe]`) so fds become 3 and 4; child dies with
  parent.
- Session/turn state machine: `starting → idle → user_turn → assistant_turn →
  idle`, treating `idle` as the only safe point to issue the next `submit`.
- Typed API surfacing: ready (with version gate), turn started/finished, idle,
  error, last-response `content`. Forwards `submit` and `interrupt`.

## Data flow (one user turn)

```
harness ── submit(text) ──fd4──► hax reads control at the input-source swap
hax runs the turn; observer + on_event emit JSONL ──fd3──► harness decodes
  ready (once at startup) / user_turn_started / assistant_turn_started
  / assistant_delta* / [tool_call_started/finished]* / assistant_turn_finished{content} / idle
harness surfaces assistant_turn_finished.content as the authoritative handback
```

Byte-for-byte example (mock provider, input `say hello`), fd 3:

```json
{"type":"ready","sessionId":"s_a1b2","protocol":"0.1.0","haxBaseCommit":"8fd139b"}
{"type":"user_turn_started","turnId":"t1"}
{"type":"assistant_turn_started","turnId":"t1"}
{"type":"assistant_delta","turnId":"t1","text":"You said: "}
{"type":"assistant_delta","turnId":"t1","text":"say hello"}
{"type":"assistant_turn_finished","turnId":"t1","content":"You said: say hello"}
{"type":"idle"}
```

`assistant_turn_started` may appear more than once per user turn (hax's inner
model→tool→model loop); `assistant_turn_finished` and `idle` fire once, when the
user turn settles. Delta boundaries are provider-driven — consumers must treat
deltas as a stream, never assume one delta equals the whole message.

## Control injection

- **`submit`** — when `--control-fd` is set, the `input_readline()` call site
  reads a JSONL control from the control fd instead of the TTY and returns its
  `text` as the submitted line. Headless input; the no-fd human REPL path is
  unchanged.
- **`interrupt`** — the existing `agent_stream_tick` (polled ~1 Hz during a
  stream, and on every received chunk) additionally non-blocking-reads the
  control fd; an `interrupt` control makes the tick return non-zero, aborting the
  in-flight turn exactly like Esc, returning the engine to `idle`.

## Error handling

- **Turn-scoped error** (EV_ERROR): emit `error{message,turnId}`; engine returns
  to `idle`; the harness may submit again.
- **Fatal/startup error:** emit `error{message}`; the session ends (child exits;
  harness observes EOF on fd 3).
- **Version gate:** the harness reads `ready.protocol`; if its **major** differs
  from the supported major, the harness refuses to drive and tears the child
  down — it never guesses semantics.
- **Transport robustness:** the codec buffers partial lines; a malformed line is
  surfaced as a protocol error, not silently dropped.

## Scope: M3a → M3b

### M3a — thin vertical slice (feasibility)

Events: `ready`, `user_turn_started`, `assistant_turn_started`,
`assistant_turn_finished{content}`, `idle`, `assistant_delta`.
Controls: `submit`, `interrupt`.
The harness reads `ready.protocol` and asserts a matching **major** version
(basic gate). Mock-provider end-to-end; human REPL rendering left intact.

**Done when:** with `HAX_PROVIDER=mock`, the harness sends one `submit` over fd 4
and observes `ready → user_turn_started → assistant_turn_started →
assistant_delta… → assistant_turn_finished{content} → idle` over fd 3, reading
`content` as the handback with no stdout parsing; an `interrupt` aborts a live
turn and returns to `idle`; and with no fds wired the human REPL output is
byte-for-byte unchanged.

### M3b — full MVP (same mechanism, widened)

Add `tool_call_started` / `tool_call_finished` and `error` end-to-end; lay
groundwork for `status` / `new_conversation` controls (full behavior in M4);
harden the version-mismatch teardown path (graceful refusal + clear error, beyond
M3a's basic major-version assertion); decide whether `assistant_delta` becomes
opt-in. No rewrite — only widened observer/codec coverage.

**Done when:** the **explicit M3 set** flows over the fds under the mock
provider — events `ready`, `user_turn_started`, `assistant_turn_started`,
`assistant_delta`, `tool_call_started`, `tool_call_finished`,
`assistant_turn_finished{content}`, `error`, `idle`, plus the controls `submit`
and `interrupt` — with the version-mismatch teardown path exercised, and the
human REPL still byte-for-byte unaffected when the protocol is off. The M4
controls (`copy_last_response`, `new_conversation`, `status`) are explicitly NOT
required to function in M3; only their documented groundwork (per the bullet
above) is in scope. Acceptance is judged against this enumerated set, not the
literal full control list in `docs/protocol.md` (which includes the M4 controls).

## Testing

- **Deterministic:** every test uses `HAX_PROVIDER=mock` (no LLM round-trip).
- **C (engine):** assert the `agent_observer` fires in the correct order and that
  `emit.c` writes well-formed JSONL for a mock turn (`meson test`).
- **TS units:** codec round-trip for every event/control; partial-line buffering;
  malformed-line surfacing; `ready.protocol` major-version gate.
- **TS e2e:** the harness drives a full mock turn over the fds, asserting the
  event sequence, the `content`, and the `interrupt` path.
- **Regression:** with no fds wired, hax's human REPL output is byte-for-byte
  identical to pre-patch (guards "protocol only active when fds are wired").

## Engine boundary guardrail

The hax patch is: `agent_observer.{c,h}` (the seam), `src/protocol/emit.c` (+
header, downstream), `--protocol-fd` / `--control-fd` flag parsing, ~5 observer
invocation points + 1 `on_event` hook + the input-source swap + the tick control
read, and one `meson.build` line. If the change needs to reach further into hax
core than this, **stop** — that behavior belongs in the TS harness, or signals
that the seam shape is wrong. The `agent_observer` seam is the upstream PR; if
upstream declines it, ai-ezio maintains just that seam patch (principled and
small), with a full fork as the last-resort fallback.

## Documentation updates required by M3

- `docs/protocol.md`: confirm/adjust the event list and document the
  `turn_finished` cardinality (one per user turn) and `assistant_delta` always-on
  decision before coding.
- `UPSTREAM.md` and `docs/architecture.md`: replace the "one file + 2–3 lines"
  characterization with the accurate `agent_observer` seam + emitter description.

## Out of scope for M3

- `--mount-mode` chrome suppression (M4).
- `copy_last_response`, `new_conversation`, `status` behavior (M4; only groundwork
  in M3b).
- ai-whisper adapter (M5) and workflow integration (M6).
- Non-fd transports (the interface allows them; no implementation in M3).

## Risks

| Risk | Mitigation |
| --- | --- |
| Upstream declines the `agent_observer` PR | Maintain the small seam patch downstream; the boundary keeps it isolated; full fork is the last resort. |
| Control-fd input swap disturbs the human REPL | Gate strictly on `--control-fd`; regression test proves the no-fd path is byte-for-byte unchanged. |
| Interrupt races (partial control lines across ticks) | Non-blocking read + partial-line buffer in `emit.c`; e2e test exercises mid-turn interrupt. |
| Delta-accumulation vs history divergence | Avoided — `content` comes from hax's finalized text via `on_turn_finished`, not re-accumulation. |
| Node fd inheritance ordering | Explicit `stdio` array with fds at indices 3/4; covered by the e2e spawn test. |
