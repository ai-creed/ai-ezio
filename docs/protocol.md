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
| `tool_call_started`        | `turnId`, `name`, `callId`, `args?`      | A tool invocation began. `args?` (M8) is a one-line summary of the call's arguments. |
| `tool_call_finished`       | `turnId`, `name`, `callId`, `status`, `output?`, `isDiff?` | Tool finished (`status`: `ok` \| `error`). `output?`/`isDiff?` (M8) carry the tool's result text and whether it is a unified diff. |
| `tool_call_requested`      | `turnId`, `name`, `callId`, `args`       | (M9) Emitted **only for delegated tools** — the host must execute and reply with a `tool_result`. `args` is the full model-supplied arguments object. Display events still fire around it; the surface renders from those and ignores this. |
| `assistant_turn_finished`  | `turnId`, `content`, `usage?`            | Turn complete; `content` is the final assistant text (the handback). `usage?` (M7) is an optional per-turn token object — see below. |
| `idle`                     | —                                        | Engine quiescent, ready for the next control. |
| `error`                    | `message`, `turnId?`                     | Recoverable or fatal error; `turnId` if turn-scoped. |
| `status`                   | `model`, `provider`, `effort?`, `protocol`, `sessionId`, `state`, `contextPercent?` | Reply to a `status` control (M4). `state` is `"idle"` in M4 (answered between turns); `contextPercent` is `null` until reliably known. `effort?` (M7) is the session's reasoning effort (string; omitted/empty when not set). |
| `compacted`                | `droppedItems`, `keptTurns`              | (M11) Confirms a `compact` control was applied; followed by `idle`. `droppedItems` counts removed items (summarized-away prefix + drop window; the inserted summary item is not counted); `keptTurns` is the user turns kept verbatim (may be lower than requested when history was shorter). |

### M7 additions (optional, back-compatible)

- **`assistant_turn_finished.usage`** — an optional object of per-turn token
  counts: `contextTokens?`, `outputTokens?`, `cachedTokens?`, `contextLimit?`
  (all optional numbers). An individual field is **omitted** when the backend
  did not report it (hax reports `-1`), and the `usage` object is **omitted
  entirely** when no field is present — never sent as `usage: null` or
  `usage: undefined`.
- **`status.effort`** — optional string (the session's reasoning effort); omitted
  or empty when not set.
- **Auto-emitted `status` in `--mount-mode`** — in addition to answering the
  `status` control, hax emits **one** `status` event automatically immediately
  after `ready` when running in `--mount-mode` (carrying `provider`/`model`/
  `effort`), so a mounted client can render a session banner without first
  sending a control. (Non-mount protocol sessions are unchanged: `status` is only
  emitted on request.)

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
| `register_delegated_tools` | `tools[]` | (M9) Sent **once after `ready`, before the first `submit`**. Merges host-provided tool defs (`{name, description, parametersSchema}`) into the advertised tool table; they serialize to the model like native tools, but their results come from the host. |
| `tool_result`         | `callId`, `output`, `status` | (M9) The host's reply to a `tool_call_requested`, correlated by `callId` (`status`: `ok` \| `error`). |
| `compact`             | `summary`, `keepLastTurns`, `dropLastTurns?` | (M11) Replace old history with a host-built summary, keeping a tail window. Processed between turns (idle), like `new_conversation` — see the M11 section. |

Example:

```json
{"type":"submit","text":"list the TODOs in this repo"}
{"type":"interrupt"}
{"type":"copy_last_response"}
{"type":"new_conversation"}
{"type":"status"}
{"type":"register_delegated_tools","tools":[{"name":"cortex__recall_memory","description":"…","parametersSchema":{"type":"object"}}]}
{"type":"tool_result","callId":"c_9","output":"…","status":"ok"}
{"type":"compact","summary":"[Context summary — session compacted]\n…","keepLastTurns":2,"dropLastTurns":1}
```

### M9 — host-delegated tools (generic MCP host)

A **delegated tool** is one hax advertises to the model but does not run itself —
its result comes from the harness (which backs it with an MCP server). hax stays
MCP-agnostic: it only knows "this tool's result comes from the host."

Sequence per delegated call: `tool_call_started` (display) → `tool_call_requested`
(delegation) → hax **blocks** on the control fd → host sends `tool_result` →
`tool_call_finished` (display). The blocking read is **interrupt-aware** (an
`interrupt` aborts the call → `[interrupted]` result) and **timeout-bounded**
(`AI_EZIO_DELEGATED_TIMEOUT`, default 120s, backstops a dead host). Tool dispatch
is sequential, so at most one delegated call is outstanding. When no
`register_delegated_tools` is sent, the delegated path is unreachable and native
behavior is byte-for-byte identical. Delegated output is capped to hax's shared
tool-output limit (`HAX_TOOL_OUTPUT_CAP`, default 50K) before entering history,
exactly like native tools.

> The ezio standalone CLI raises `AI_EZIO_DELEGATED_TIMEOUT` to 30 minutes by
> default (when unset) so a long-running `subagent` delegated call is not cut off
> by the dead-host backstop; set the env var explicitly to override.

### M11 — context compaction

The `compact` control replaces all conversation history except a trailing
window with a host-built summary. Processed between turns (idle), like
`new_conversation`.

```json
{"type": "compact", "summary": "<text>", "keepLastTurns": 2, "dropLastTurns": 1}
```

- `summary` (string, required, non-empty): becomes the first item of the new
  history, as a user message.
- `keepLastTurns` (int >= 0, required): user turns kept verbatim at the tail.
- `dropLastTurns` (int >= 0, optional, default 0): newest user turns discarded
  entirely *before* the keep window is computed (covers dangling/aborted
  trailing turns; the ezio harness uses it to exclude its in-session
  summarization exchange).
- Bounds: `dropLastTurns >=` turn count → history becomes `[summary]` only.
  After dropping, `keepLastTurns >=` remaining turns → nothing further
  dropped.
- Invalid control (empty/missing summary, missing/negative `keepLastTurns`,
  negative `dropLastTurns`): session untouched, an `error` event is emitted.
- On success the engine rotates the session log and transcript mirror and
  re-seeds them with the post-compact history (so `--resume`/`--continue` of
  the rotated file reproduces post-compact state), emits `compacted`, then
  `idle`.

**Ordering rule for raw-protocol hosts:** the engine processes controls
strictly in arrival order at idle boundaries. A host driving `compact`
directly must not interleave its own `submit` between the steps of a
summarize-then-compact cycle. (The ezio harness serializes this via its
session turn gate.)

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
- **`tool_call_started` / `tool_call_finished` semantics:** in M3 these reported
  the model's tool-call *stream lifecycle* (`status:"ok"` meant "args finalized",
  not execution). **As of M8 they are emitted from hax's tool-dispatch seam**
  (around `tool->run`): `tool_call_started{args?}` fires just before the tool runs
  (args known), and `tool_call_finished{status,output?,isDiff?}` fires just after,
  so `status` now reflects **execution** (`ok` for a run, `error` for a
  refused/skipped call), `output?` is the tool's result text, and `isDiff?` is a
  boolean (true when the output is a unified diff). All three new fields are
  optional/back-compatible; older consumers ignore them. The M3 "future
  enhancement (a `tool_result` event)" note is superseded by this M8 design.
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
