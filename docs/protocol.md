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
hax --mount-mode --protocol-fd=3 --control-fd=4
```

The harness opens the pipes and passes them as fds 3 and 4 to the child. When
the parent exits, the child exits (no orphaned engine).

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

## Engine-side implementation note

The emitter (`vendor/hax/src/protocol/emit.c`) hooks hax's existing
`turn` `on_event(struct stream_event *)` callback and translates each
`stream_event` (text delta, tool-call start/delta/end, reasoning, done, error)
into the JSONL events above, writing to the protocol fd. Controls are read from
the control fd and injected into the same input path the REPL uses. Keep this
surface tiny and upstreamable (see `UPSTREAM.md`).

## Open questions

- Should `assistant_delta` be opt-in (a control to enable streaming) to reduce
  fd traffic for consumers that only want final content?
- Do we need a `tool_call_delta` for long-running tool output, or is
  started/finished enough for ai-whisper's needs?
- Status event payload shape (model, context %, provider) — define when
  `--version --json` lands in Milestone 1/3.
