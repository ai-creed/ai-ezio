# ezio mounted-mode transcript view (Ctrl+T) — design

**Status:** Approved, pending implementation. Option **B1** (reuse hax's
`HAX_TRANSCRIPT` mirror) confirmed with owner 2026-06-11.
**Rev. 1 (2026-06-11):** the transcript filename now uses a caller-minted
**pre-spawn** id, not the protocol session id (review fix — `ready.sessionId` is
not known until after hax is spawned, but `HAX_TRANSCRIPT` must be set in the
child env *before* spawn).
**Date:** 2026-06-11
**Scope:** the harness spawn seam (`packages/harness`), the `ai-ezio` standalone
self-mount REPL (`packages/cli`), and docs. **No hax C change.** Whisper-side
wiring is a separate downstream follow-up in the `ai-whisper` repo (the harness
seam this design adds is what whisper consumes).

## Motivation

hax has an interactive **Ctrl+T transcript view**: it pages the current
session's *model-perspective* transcript — the full system prompt, every
advertised tool schema, and every conversation item in order (user / assistant /
tool-call JSON args / tool-result / reasoning blocks / turn boundaries). This is
a high-value debugging affordance: it shows *exactly what the model sees*.

That view is **lost in ezio's standalone self-mount and in ai-whisper's mounted
mode**, because Ctrl+T lives inside hax's interactive raw-mode TUI input loop
(`vendor/hax/src/terminal/input.c:1276` → `show_transcript()`), and under the
unified architecture hax is always **headless** — stdin/stdout/stderr ignored, no
TUI loop, the transcript callback never even registered
(`vendor/hax/src/agent.c:924`). So the keybind is structurally unreachable; the
capability must be rebuilt on the ezio side, fed by hax's own data.

## Findings (what hax already provides)

Read of `vendor/hax/src/transcript.c`, `agent.c`, `terminal/input.c`:

1. **`HAX_TRANSCRIPT=<path>` is the same content as Ctrl+T, color-off.** When the
   env var is set, hax mirrors the live transcript to that file:
   `transcript_log_open()` (`transcript.c:402`) truncates the file on startup and
   writes a header (banner + system prompt + tools); `transcript_log_append()`
   (`transcript.c:428`) renders new items (`items[n_written..n_items)`)
   incrementally with `color=0`. The file is **line-buffered** (`setvbuf`), so it
   is always current for a `cat`/pager read. This is the *same renderer* the
   interactive Ctrl+T uses (`transcript_render`), just plain-text.

2. **The mirror tracks conversation lifecycle.** `/new` calls
   `transcript_log_reset()` → the file is reset to the fresh conversation. On
   `--continue` / `--resume`, hax replays prior history through
   `transcript_log_append()`, rebuilding the mirror with the resumed context.
   *(Both behaviors confirmed against `vendor/hax` during Phase 1 — see Open items.)*

3. **No protocol/C change needed.** The mirror is purely an env-var opt-in. This
   keeps the hax fork untouched (honors the "extend hax only when absolutely
   necessary, keep it rebaseable" decision), and keeps hax the single source of
   truth for the transcript's rendering (we do not re-implement the view in TS).

### Why B1 over the alternatives (recorded for posterity)

- **A — render ezio's `session-recorder`:** rejected as the primary. The recorder
  is turn-level (`RecordedTurn` = userText / assistantText / toolCalls / usage),
  capped at a 30-turn in-memory ring, and carries **no** system prompt, tool
  schemas, or reasoning. That is a weaker, different feature ("scroll my
  conversation") than hax's "what the model sees."
- **B2 — read hax's session `.jsonl` and re-render in TS:** rejected. It couples
  ezio to hax's private on-disk item schema — exactly what the resume design
  deliberately avoided by consuming a seam instead of re-deriving the layout.
- **C — add a `get_transcript` protocol control + `transcript` event:** deferred.
  It is the cleanest long-term, protocol-native seam (live, on-demand, uniform
  for every consumer) and would be the natural upgrade if/when a `/context`
  feature or richer styling justifies a hax change. B1 subsumes the immediate
  need with no fork change; C remains the documented upgrade path.

## Design

### 1. Harness seam (shared by both consumers)

The harness owns the **mechanism** but stays filesystem-layout-agnostic (path is
chosen by the caller, matching how `packages/session-recorder` owns ezio's fs
layout, not the harness):

- `packages/harness/src/spawn.ts` — `SpawnHaxOptions` gains an optional
  `transcriptPath?: string`. When set, `haxSpawnEnv()` injects
  `HAX_TRANSCRIPT=<transcriptPath>` into the child env (alongside the existing
  `HAX_EXTRA_SKILLS_DIR`). When unset, behavior is unchanged (no mirror).
- `packages/harness/src/session.ts` — `Session.start()` threads
  `transcriptPath` through to `spawnHax`, and the `Session` exposes a read-only
  `transcriptPath?: string` getter so any consumer (ezio CLI, ai-whisper) reads
  the path from the harness rather than re-deriving the env contract.

### 2. Path (ezio standalone)

`packages/cli/src/repl/standalone-runtime.ts` already computes `ezioStateDir()`
and `repoKeyForPath(cwd)`. It derives a **pre-spawn** path:

```
<ezioStateDir>/transcripts/<repoKey>/<transcriptId>.txt
```

where `transcriptId` is a **caller-minted id generated before spawn**
(`crypto.randomUUID()`; a timestamp+pid composite would also work). This is
deliberate and load-bearing: the protocol `ready.sessionId`
(`packages/protocol/src/events.ts`) is only known *after* `Session.start()` has
spawned hax, but hax opens the `HAX_TRANSCRIPT` file *before* it emits `ready`
(`vendor/hax/src/agent.c:925-928`), so the env var — and therefore the filename —
must be fully determined **before** spawn. Keying the file on the protocol
session id is impossible without a hax/protocol change, which the "No hax C
change" scope forbids; a caller-minted id sidesteps the ordering entirely and
keeps the harness layout-agnostic (it still receives a finished path).

(one stable file per hax process; hax handles `/new` reset and resume rebuild
internally, so a per-process path is correct). The dir is `mkdir -p`'d before
spawn; the path is passed to `session.start({ env, transcriptPath })` and held
for the REPL/slash wiring. Inspectable, and mirrors the `session-recorder`
durable-store layout (`<stateDir>/sessions/<repoKey>/…`).

**Optional id correlation.** If a transcript file ever needs to be tied back to
the protocol session, the harness already exposes `session.ready` once the
`ready` event arrives, so a consumer can log the `transcriptId ↔ ready.sessionId`
mapping at that point (e.g. into the session record). Renaming the open mirror
file is intentionally avoided — hax holds it open for the process lifetime.

### 3. Keystroke intercept (ezio standalone)

`packages/cli/src/repl/input-reader.ts` — `feedKey()` currently drops control
chars at the `ch < " "` guard (line 143). Recognize `0x14` (Ctrl+T) and return a
new out-of-band signal `{ signal: "transcript" }` (extend the `KeyResult.signal`
union). Pure reducer, fully unit-testable without a TTY.

### 4. REPL dispatch + render (ezio standalone)

- `packages/cli/src/repl/standalone.ts` — in the loop, handle `r.signal ===
  "transcript"` *before* the submit branch: `await deps.showTranscript?.()` then
  `continue` (no echo, no submit, no interrupt). A new
  `showTranscript?: () => Promise<void>` is added to `StandaloneReplDeps` so the
  loop stays free of `fs`/`child_process` imports.
- `packages/cli/src/repl/standalone-runtime.ts` — implements `showTranscript`:
  1. If the mirror file is missing or empty (no turns yet) → write a dim
     "no transcript yet" line, return (no pager spawn).
  2. Suspend raw mode (`stdin.setRawMode(false)`), spawn `$PAGER` (default
     `less -R`) with the file on inherited stdio, `await` its exit, then restore
     raw mode (`setRawMode(true)`) and `renderer.renderPrompt()`. Raw-mode
     restore is in a `finally` so a pager crash can't strand the terminal.
  3. No-TTY / no-pager fallback: read the file and write it inline to stdout.

  **Natural concurrency safety:** the REPL's `for await` loop blocks on
  `session.submitAndWait()` during a turn (`standalone.ts:71`), so keystrokes are
  only processed at settled boundaries. A Ctrl+T pressed mid-stream is handled
  right after the turn finishes — the pager never fights the live renderer for
  stdout. No extra gating needed.

### 5. `/transcript` slash command (ezio standalone)

Register a `/transcript` command on the existing `SlashController`
(`standalone-runtime.ts:177-192`) that calls the same `showTranscript`. Gives a
discoverable, keybind-free path (and the same entry point ai-whisper can route a
command to). Outcome is `"handled"` (no engine round-trip; loop redraws prompt).

### 6. ai-whisper (downstream follow-up — not in this repo)

ai-whisper owns its own line-buffered input loop (`live-session.ts`
`feedLineBufferedInput`). With `session.transcriptPath` exposed by the published
`@ai-ezio/harness`, whisper's change is a ~10-line Ctrl+T intercept that opens
the same path in a pager. Tracked as a separate task in the `ai-whisper` repo;
this design's harness seam is the prerequisite it consumes.

## Phasing (keeps each step ≤ 3 files of product change)

- **Phase 1 — harness seam.** `spawn.ts` + `session.ts` (+ tests). Deliverable:
  spawning with `transcriptPath` sets `HAX_TRANSCRIPT` and exposes the path.
- **Phase 2 — ezio keybind + render.** `input-reader.ts` + `standalone.ts` +
  `standalone-runtime.ts` (+ slash registration, tests).
- **Phase 3 — docs + handoff.** Note the new env contract (architecture/AGENTS),
  record the decision in cortex memory, and file the downstream ai-whisper task.

## Testing (TDD — write first)

- `feedKey`: `0x14` → `{ signal: "transcript" }`; not dropped by the control-char
  guard; unaffected mid-paste / mid-ESC-sequence.
- `haxSpawnEnv` / `spawnHax`: `HAX_TRANSCRIPT` present and equal to the provided
  `transcriptPath`; absent when no path given.
- `Session`: exposes `transcriptPath` after `start`.
- **Pre-spawn ordering:** the standalone runtime computes `transcriptPath` (with
  its caller-minted `transcriptId`) and passes it to `session.start` **without
  awaiting `ready`** — no dependency on `ready.sessionId`. A test asserts the
  path is finalized before spawn (e.g. a fake `start` records the env it was
  given and `HAX_TRANSCRIPT` is already set on that first call).
- `runStandaloneRepl`: a `"transcript"` signal invokes `showTranscript` exactly
  once, does **not** submit/interrupt, and the loop continues; prompt redraw
  follows.
- `showTranscript`: picks `$PAGER`, falls back to `less -R`, then inline;
  missing/empty file → message, no pager spawn; raw mode restored even when the
  pager exits non-zero.
- `/transcript` slash → calls `showTranscript`, outcome `"handled"`.

## Edge cases

- **No turns yet** (file absent/empty) → friendly message, no pager.
- **`$PAGER` unset / `less` missing** → `less -R` then inline-cat fallback.
- **Pager exits non-zero or user quits** → raw mode + prompt restored via
  `finally`.
- **Ctrl+T mid-turn** → handled at the next settled boundary (loop blocks on the
  turn); no stdout contention.
- **`/new`** → hax resets the mirror; the view shows only the new conversation
  (consistent with `recorder.noteNewConversation`).
- **Resume (`--continue`/`--resume`)** → mirror rebuilt with replayed history
  (confirmed: `agent.c:843-844` reset + append, `:947`).

## Open items — resolved in Phase 1 (verified against `vendor/hax`)

1. **Resume rebuild — CONFIRMED favorable.** `--continue`/`--resume` rebuild the
   `HAX_TRANSCRIPT` mirror with the replayed history: `agent.c:843-844` does
   `transcript_log_reset` + `transcript_log_append(s->items, s->n_items)`, and the
   startup path appends the full loaded history (`agent.c:947`). A resumed
   session's Ctrl+T view shows the prior conversation immediately — it does not
   start empty.
2. **Post-compaction fidelity — CONFIRMED favorable (earlier caveat retracted).**
   `/compact` does NOT leave a stale append-only tail. `agent_compact`
   (`agent.c:611-623`) calls `transcript_log_reset` then re-seeds with the full
   post-compact history via `flush_logs(items, n_items)` — the inline comment reads
   "re-seed them with the full post-compact history (both resets zero their
   incremental cursors)." So the file mirror reflects the compacted state and
   matches the live Ctrl+T view; there is **no** B1-versus-C compaction fidelity
   gap.
