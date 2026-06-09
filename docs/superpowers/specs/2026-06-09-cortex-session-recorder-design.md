# Cortex session recorder for ezio — design

Status: **design (approved in brainstorm 2026-06-09)**, ready for an implementation
plan. Supersedes the exploratory note
`docs/superpowers/ideas/2026-06-09-cortex-capture-parity-ideas.md`.

## Problem

ai-cortex captures durable knowledge from a coding-agent **host** by reading that
host's **transcript** (its raw conversation log) and building its own searchable
history cache. cortex ships **hardcoded feeders for exactly two hosts** — Claude
Code (a `PreCompact` + `SessionEnd` hook that runs the `ai-cortex history capture`
CLI) and Codex (`UserPromptSubmit` + `Stop` hooks running the same CLI). Both pipe
`{session_id, transcript_path}` to the CLI; cortex reads the file and runs
`captureSession()`.

ezio is **neither host**: it has no hook surface and writes no
cortex-readable transcript, so **cortex cannot capture an ezio session at all**.
hax *does* write its own per-session JSONL (`$XDG_STATE_HOME/hax/sessions/…`) but in
hax's own lossless schema, which cortex's parser cannot read — and reading it would
be engine-scraping anyway.

## Key facts established during design

- **hax does not compact or summarize.** A full grep of `vendor/hax/src` finds no
  compaction/summarization/pruning. Context grows until the model limit; `/new`
  (the `new_conversation` control) clears it. **There is no "before history loss"
  moment** — so the capture triggers are turn-end, `new_conversation`, and
  session-close, *not* a precompact equivalent.
- **cortex ingestion is file-based pull, not RPC push.** There is no MCP tool to
  push a session in. A host must (1) write a transcript file in cortex's
  Claude-Code schema, then (2) cause `captureSession({repoKey, sessionId,
  transcriptPath, embed})` to run.
- **`captureSession` re-embeds the whole session every call.** Verified in
  `ai-cortex/src/lib/history/capture.ts:50–113`: on any new turn it runs
  `chunkTurns(allTurns)` and `provider.embed(<all chunks>)` over the entire
  history — an embedding round-trip per capture, i.e. O(n²) if called per turn.
  It already computes `newTurns` (turn index > `lastProcessedTurn`) and
  short-circuits when empty, but does not use it to bound the work.

## Goals

- ezio sessions are captured by cortex **seamlessly when cortex is bundled in**,
  with **no scraping** — the recorder is built from the fd-3 protocol event stream
  ezio already receives (and the `submit` text ezio itself sent).
- **All cortex-specifics quarantined** behind a generic seam, consistent with the
  "ezio is a generic MCP host, not a cortex-specific bash-CLI" decision
  (`mem-2026-06-08-ezio-integrates-the-ai-ecosystem-as-a-caf0cf`).
- ezio captures **its own per-turn telemetry** (token usage) durably for future use.

## Non-goals (v1)

- Incremental capture inside cortex (avoiding the whole-session re-embed). Tracked
  as **follow-up B**, owned separately; the tool signature here is designed so that
  swap is invisible to ezio.
- A bespoke ecosystem IPC channel (unix socket / spool) for capture. Parked; revisit
  only if such a channel carries more than capture traffic.
- A hax-side context/`set_context` seam, the Context Steward, and the `/usage`
  rate-limit emitter — all parked in their own idea docs.

## §1 Architecture & boundaries

Three components; **every cortex-ism lives in one adapter**.

```
   fd3 protocol events                  neutral turn model            sink boundary calls
   (user_turn_started,        ┌──────────────────────────┐         ┌────────────────────────┐
    assistant_turn_finished,  │     SessionRecorder       │         │   CortexSessionSink     │
    tool_call_*, idle, …)  ──►│  (generic, cortex-blind)  │──turns─►│  (the ONLY cortex code) │
                              │  builds Conversation model │ +bound  │  • serialize → Claude-  │
   harness already knows the  │  persists ezio's durable   │         │    format projection    │
   submit text (it sent it)   │  record; emits lifecycle   │         │  • own its file         │
                              │  to a SessionSink          │         │  • call cortex MCP tool │
                              └──────────────────────────┘         │    capture_session()    │
                                          │                          └────────────┬───────────┘
                                   depends only on                                │ via mcp-host
                                   `SessionSink`                       (harness-invoked, NOT
                                                                        advertised to the model)
```

- **`SessionRecorder`** (generic, cortex-blind): consumes the protocol event stream,
  maintains the neutral `ConversationModel`, persists ezio's durable session record
  (source of truth), and emits lifecycle events to a `SessionSink`.
- **`SessionSink`** (the generic seam): `onTurnComplete(turn)`,
  `onConversationBoundary(reason)`, `onClose()`. Knows nothing about cortex, file
  formats, or MCP. Swapping it points ezio at a different memory system, or none.
- **`CortexSessionSink`** (the quarantine): the only code that knows the Claude-Code
  transcript schema, the projection file path, and the `capture_session` tool name.
  Calls cortex through `mcp-host` **as the host** — never via
  `register_delegated_tools`, so the model can neither see nor call it.

**Location:** new package `packages/session-recorder` (recorder + `SessionSink` +
`CortexSessionSink`), depending on `protocol` (event types) and `mcp-host` (to
invoke the tool). Small and single-purpose rather than swelling `harness`.

**IDs:** reuse hax's `ready.sessionId`; mint a fresh `conversationId` (sessionId +
counter) when the harness sends `new_conversation`. cortex derives its own `repoKey`
from the `worktreePath` ezio passes — ezio never computes it. All ids sanitized to
cortex's `^[\w-]+$`.

**Artifact paths (ezio-owned):** the durable record and the cortex projection live
under ezio's state tree, e.g.
`$XDG_STATE_HOME/ezio/sessions/<repoKey>/<conversationId>.record.jsonl` (durable,
with usage) and `…/<conversationId>.cortex.jsonl` (the Claude-format projection handed
to cortex as `transcriptPath`). Both are append-only.

## §2 Data model & event mapping

Neutral model (ezio's durable record is the persisted form of this):

```ts
ConversationModel { sessionId, conversationId, worktreePath, startedAt, turns: Turn[] }
Turn {
  index
  userText          // the submit WE sent, correlated to user_turn_started
  assistantText     // assistant_turn_finished.content (authoritative handback)
  toolCalls: { name, input, status, isDiff?, output? }[]
  usage?            // contextTokens/outputTokens/cachedTokens/contextLimit — PERSISTED
}
```

`usage` is **ezio telemetry, not cortex memory data** (cortex's turn schema has no
usage field). It is persisted in ezio's durable record and **omitted from the cortex
projection**.

Protocol signal → model:

| Signal | Action |
| --- | --- |
| harness `submit{text}` (control we send) | stash pending user text |
| `user_turn_started{turnId}` | open a `Turn`, attach the stashed submit text |
| `assistant_turn_started` | no-op (fires multiple times across the inner loop) |
| `assistant_delta` | ignored for capture — use final content, never reconstruct |
| `tool_call_started{name,callId,args?}` | append a toolCall (args = one-line summary for native tools) |
| `tool_call_requested{name,callId,args}` | delegated/MCP tools: upgrade `input` to the full args object |
| `tool_call_finished{name,callId,status,output?,isDiff?}` | complete the matching toolCall |
| `assistant_turn_finished{content,usage?}` | close the Turn: `assistantText`, stash `usage` |
| `idle` | turn settled → `sink.onTurnComplete(turn)` |
| harness `new_conversation` | `sink.onConversationBoundary("new")`, then rotate id |
| fd3 EOF / shutdown | `sink.onClose()` |

Model → cortex projection (in `CortexSessionSink` only), two Claude-format lines per
completed turn:

```jsonl
{"type":"user","turn":4,"message":{"content":[{"type":"text","text":"<userText>"}]}}
{"type":"assistant","turn":5,"message":{"content":[{"type":"text","text":"<assistantText>"},{"type":"tool_use","name":"Read","input":{"file_path":"src/x.ts"}}]}}
```

cortex re-parses the file on each capture (idempotent), so append-per-turn is safe.
We never set `isSidechain` and never emit `type:"summary"` (ezio has no compaction →
`hasSummary:false`). The projection carries tool **name + input only** (cortex's
evidence layer needs that); full tool I/O stays in ezio's durable record.

**v1 fidelity trade-offs (deliberate):** (1) native-tool args are a one-line summary,
not structured input — acceptable because cortex truncates args to ~120 chars and
delegated tools still give full structured input; (2) intermediate assistant prose
(deltas) is dropped, only final content + tool list is captured — adequate for
cortex's evidence; (3) usage is dropped from the projection (kept in ezio's record).

## §3 Lifecycle & trigger policy (Lever A — no cortex-internals change)

**Per turn (cheap, every turn):** append the completed turn to ezio's durable record
and to the cortex projection file. **No capture call.**

**Trigger `capture_session` only on:**
- `new_conversation` — final capture for the current conversation, then rotate
  `conversationId` and start a fresh projection file.
- `session-close` (fd3 EOF / harness shutdown) — final best-effort, time-boxed capture.
- **idle-debounce** — timer reset on each `idle`; fires after `idleDebounceMs` quiet.
- **every-K-turns** safety cap — periodic capture for long, continuously-active
  sessions.

`idleDebounceMs` and `K` are config knobs (defaults 10s / 10 turns).

**Safety:** every capture call is fire-and-forget (async, errors logged, never blocks
the turn loop). cortex's per-session lock makes overlapping triggers safe
(`skipped-locked`); its `up-to-date` short-circuit makes a redundant trigger a
near-no-op.

**Recovery sweep (in for v1):** on startup, the recorder scans ezio's session records
and triggers `capture_session` for any whose projection file is newer than cortex's
last capture (closing the gap left by a crash before a final capture).

## §4 Cortex-side change

One small, **host-agnostic** MCP tool added to cortex's server, wrapping the existing
function:

```ts
// ai-cortex: src/mcp/server.ts — new tool
capture_session({ worktreePath, sessionId, transcriptPath, embed? })
  → repoKey = repoIdentity(worktreePath)        // existing
  → return captureSession({ repoKey, sessionId, transcriptPath, embed })  // existing
```

~a dozen lines. Names nothing about ezio — *any* host that writes a cortex-format
transcript can call it; it is the generic "session-sink" capability cortex merely
implements. **Follow-up B** (incremental capture) later swaps the *body* of
`captureSession`, same signature, invisible to ezio.

## §5 Edge cases

- **Empty / tool-only turn** (`content == ""`): still recorded; cortex tolerates it.
- **Interrupt / turn-scoped error mid-turn**: finalize the partial turn on the return
  to `idle` (user text + completed tool calls).
- **`new_conversation` before any turn**: capture is a no-op; still rotate the id.
- **Rapid boundaries / overlapping triggers**: cortex lock → `skipped-locked`.
- **ID sanitization**: to cortex's `^[\w-]+$`.
- **Large tool output**: projection carries tool name + input only; full I/O in ezio's
  record.
- **Partial `usage`**: omit fields the backend didn't report.
- **cortex history disabled**: capture returns `disabled`; ezio's record still written.
- **Torn final line on crash**: append whole lines atomically; cortex's parser
  tolerates skipping a torn trailing line.

## §6 Testing (TDD — write first)

1. **Recorder unit** — scripted protocol event sequence → assert neutral model
   (user-text correlation via the sent submit, tool calls, usage).
2. **Projection round-trip (high value)** — feed our cortex-format output through
   cortex's real `parseTranscript` + `extractEvidence` → assert tool calls / file
   paths / user prompts. Pins the format contract to cortex's actual parser.
3. **Trigger policy** (fake timers) — capture fires on boundaries, idle-debounce, and
   every-K, and **not** every turn.
4. **Sink boundaries** — `new_conversation` rotates id+file + final capture; `close`
   → final capture.
5. **Recovery sweep** — a projection newer than cortex's last capture is swept on
   startup.
6. **Concurrency/idempotency** — overlapping triggers tolerate `skipped-locked`.

## Open questions / future

- **Follow-up B (separate track):** incremental capture inside cortex — parse / chunk
  / embed / extract only appended turns (append-only transcript), turning per-turn
  capture into O(delta). Benefits Claude/Codex too. Same `capture_session` signature.
- **Richer native-tool args / assistant deltas** in the projection — only if cortex's
  evidence quality proves it needs them (would touch the protocol for native args).
- **Ecosystem IPC channel** — revisit only if it carries more than capture traffic.

## Decisions log

- **Trigger channel = generic MCP tool ezio's harness calls** (not bash-CLI, not a
  new socket, not a direct lib import). Honors the generic-MCP-host decision; capture
  stays off the model's tool surface.
- **Lever A (frequency policy) for v1**; Lever B (incremental capture) is a separate
  cortex track.
- **ezio owns a durable session record** (with usage) as source of truth; the cortex
  transcript is a derived projection.
- **Recovery sweep included** in v1.
