# ai-ezio machine protocol

The explicit contract between the hax engine and the ai-ezio harness (and
through it, ai-whisper). Replaces TUI scraping with structured messages.

## Transport

- **Wire format:** JSONL — one JSON object per line, UTF-8, `\n`-terminated.
- **Default transport:** inherited file descriptors.
  - **fd 3** — *events*: hax writes, harness reads.
  - **fd 4** — *controls*: harness writes, hax reads.
- **stdout / stderr stay human-only.** The terminal REPL is never mixed with
  protocol traffic. This is what makes the human UI and machine control
  coexist cleanly.
- **Pluggable seam.** The wire format is transport-independent. A Unix-socket or
  stdio-framing transport can be added later behind the same codec; the message
  schema below does not change.

hax is launched with the fds wired:

```sh
hax --protocol-fd=3 --control-fd=4
```

There is **no `--mount-mode` flag in M3** — the presence of `--control-fd` makes
hax read `submit`/`interrupt` from the control fd instead of the TTY. REPL chrome
suppression (a `--mount-mode` behavior) is deferred to M4. The harness opens the
pipes and passes them as fds 3 and 4 to the child. When the parent exits, the
child exits (no orphaned engine).

## Versioning

Every session begins with a `ready` event carrying a `protocol` version string
(semver). The harness refuses to drive an engine whose major version it does not
support. Add fields backward-compatibly; bump major only on breaking changes.

## Events (hax → harness, fd 3)

| `type`                     | Fields                                   | Meaning |
| -------------------------- | ---------------------------------------- | ------- |
| `ready`                    | `sessionId`, `protocol`, `haxBaseCommit` | Engine up, idle, ready for controls. |
| `user_turn_started`        | `turnId`                                 | A submitted user turn was accepted. |
| `assistant_turn_started`   | `turnId`                                 | Model began responding. |
| `assistant_delta`          | `turnId`, `text`                         | Streamed text chunk (optional for consumers that only want final). |
| `tool_call_started`        | `turnId`, `name`, `callId`               | A tool invocation began. |
| `tool_call_finished`       | `turnId`, `name`, `callId`, `status`     | Tool finished (`status`: `ok` \| `error`). |
| `assistant_turn_finished`  | `turnId`, `content`                      | Turn complete; `content` is the final assistant text (the handback). |
| `idle`                     | —                                        | Engine quiescent, ready for the next control. |
| `error`                    | `message`, `turnId?`                     | Recoverable or fatal error; `turnId` if turn-scoped. |

Example stream:

```json
{"type":"ready","sessionId":"s_01","protocol":"0.1.0","haxBaseCommit":"8fd139b"}
{"type":"user_turn_started","turnId":"turn_1"}
{"type":"assistant_turn_started","turnId":"turn_1"}
{"type":"assistant_delta","turnId":"turn_1","text":"Looking at the repo..."}
{"type":"tool_call_started","turnId":"turn_1","name":"bash","callId":"c_1"}
{"type":"tool_call_finished","turnId":"turn_1","name":"bash","callId":"c_1","status":"ok"}
{"type":"assistant_turn_finished","turnId":"turn_1","content":"Done. 3 TODOs found."}
{"type":"idle"}
```

## Controls (harness → hax, fd 4)

| `type`                | Fields   | Meaning |
| --------------------- | -------- | ------- |
| `submit`              | `text`   | Submit a user turn. |
| `interrupt`           | —        | Cancel the in-flight turn (maps to hax's Esc/cancel). |
| `copy_last_response`  | —        | Re-emit the last `assistant_turn_finished.content`. |
| `new_conversation`    | —        | Start a fresh conversation (maps to `/new`). |
| `status`              | —        | Request a status event (engine/session health). |

Example:

```json
{"type":"submit","text":"list the TODOs in this repo"}
{"type":"interrupt"}
{"type":"copy_last_response"}
{"type":"new_conversation"}
{"type":"status"}
```

## Lifecycle / state machine

```text
spawn ──► [starting] ──ready──► [idle] ──submit──► [user_turn] ──► [assistant_turn]
                                  ▲                                      │
                                  │                       assistant_turn_finished
                                  └──────────────── idle ◄──────────────┘
[assistant_turn] ──interrupt──► (turn aborted) ──► error? ──► idle
any state ──► error  (turn-scoped errors return to idle; fatal errors end the session)
```

Rules:

- The harness treats `idle` as the only safe point to issue the next `submit`.
- `assistant_turn_finished.content` is the authoritative handback text — never
  scrape stdout for it.
- `copy_last_response` exists so a handback can be re-fetched without re-running
  a turn (and without clipboard access).

## M3 decisions (locked)

- **`assistant_turn_finished` cardinality:** one per **user** turn. `content` is
  the **last assistant message of the user turn** (the final answer the user
  reads); empty string if the turn produced no assistant text (e.g. a tool-only
  turn). Intermediate prose across hax's inner model→tool→model loop remains
  available via `assistant_delta`. `assistant_turn_started` may therefore appear
  more than once per user turn; `assistant_turn_finished` and `idle` fire once.
- **`content` source:** hax's own finalized assistant text, delivered through the
  `agent_observer` `on_turn_finished` callback — never reconstructed from deltas.
- **`assistant_delta`:** always-on in M3 (no opt-in control yet); revisit in a
  later milestone.
- **`tool_call_started` / `tool_call_finished` semantics:** these report the
  **model's tool-call stream lifecycle** — `tool_call_started` when the call
  begins (`EV_TOOL_CALL_START`), `tool_call_finished` when its args are finalized
  (`EV_TOOL_CALL_END`). They are **not** the tool's *execution* outcome. In M3,
  `status` is `"ok"` meaning "the call was fully formed"; it does **not** indicate
  whether the tool ran successfully (that happens later in hax's dispatch loop).
  Reporting execution result is a future enhancement (a `tool_result` event or a
  richer `status`), out of scope for M3.
- **`error` event:** turn-scoped — `error{message,turnId}` is emitted, then the
  engine returns to `idle` (so the turn's `assistant_turn_finished`/`idle` still
  fire); the harness surfaces it as recoverable. A fatal/startup failure ends the
  engine, which the harness observes as fd-3 EOF (the authoritative fatal signal).

## Engine-side implementation note

Two seams carry the protocol, keeping the downstream patch minimal and the
upstream surface clean:

- **Lifecycle** (`ready`, `user_turn_started`, `assistant_turn_started`,
  `assistant_turn_finished`, `idle`) rides a new, upstreamable
  `struct agent_observer` seam in hax (`vendor/hax/src/agent_observer.h`) — a
  general-purpose set of optional agent-loop hooks (mirrors `struct provider` /
  `struct tool`). The agent invokes the hooks at well-defined points in
  `agent_run`; `on_turn_finished` passes hax's finalized assistant text.
- **Stream events** (`assistant_delta`, `tool_call_started`/`finished`, `error`)
  ride hax's existing `on_event(struct stream_event *)` callback via a single
  added hook.

The downstream emitter (`vendor/hax/src/protocol/emit.c`) implements
`agent_observer`, translates the relevant `stream_event`s, serializes everything
to JSONL on the protocol fd, and reads/parses controls from the control fd
(blocking read for `submit` at the input-source swap; non-blocking poll for
`interrupt` from the stream tick). Keep this surface tiny and upstreamable (see
`UPSTREAM.md`).

## Open questions

- Should `assistant_delta` be opt-in (a control to enable streaming) to reduce
  fd traffic for consumers that only want final content?
- Do we need a `tool_call_delta` for long-running tool output, or is
  started/finished enough for ai-whisper's needs?
- Status event payload shape (model, context %, provider) — define when
  `--version --json` lands in Milestone 1/3.
