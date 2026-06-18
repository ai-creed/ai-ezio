# ezio `/resume` and `/rename` slash commands — design

**Status:** approved (brainstorm)
**Date:** 2026-06-18
**Scope:** Two new ezio slash commands — `/resume` (switch the live session to a
past one) and `/rename` (give the current session a friendly title) — working in
**both** standalone ezio and a mounted ezio pane (`whisper collab mount ezio`).
Spans two repos (`ai-ezio` + `ai-whisper`); see §7.
**Predecessors:**
- `2026-06-14-ezio-mounted-slash-commands-design.md` — relocated the slash
  machinery into `@ai-ezio/surface` and made the mounted adapter reuse the same
  `SlashController`. This spec adds two commands to that shared registry.
- `2026-06-10-ezio-repl-resume-design.md` — established that hax implements
  `--continue` / `--resume[=ID]` end to end, that `--mount-mode` does **not**
  suppress resume (only human chrome), that hax's own `/resume` TUI picker
  cannot run headless, and added the generic `hax --list-sessions` JSON seam plus
  ezio's own startup picker (`runResumePicker`).
- `2026-06-11-ezio-transcript-view-design.md` — the precedent for an interactive
  full-screen overlay (raw-mode pager) that suspends/restores the standalone line
  reader; `/resume`'s arrow picker reuses that suspend/restore pattern.

## Motivation

ezio's standalone and mounted REPLs share one slash registry (`SlashController`
in `@ai-ezio/surface`) but ship neither `/resume` nor `/rename`:

- **`/resume` is startup-only.** Resuming a past session is reachable only via the
  `--resume` / `--continue` CLI flags at launch (the startup `runResumePicker`).
  There is no in-REPL command to switch to a different session mid-run.
- **`/rename` does not exist, and hax has no session-title concept.** A hax
  session is `<ts>_<uuid>.jsonl`, surfaced only by `firstPrompt` + `mtime` (all the
  `--list-sessions` JSON carries). Sessions are addressed by opaque uuids no human
  remembers, which makes the resume list hard to scan.

Both gaps are felt equally in standalone and mounted use, so both commands target
both surfaces. The shared `SlashController` plus its documented `register()`
extension seam make a single command definition reach both — the cost is wiring
the new per-mode capabilities each command needs.

## Goals

- `/rename <text>` titles the **current** session; `/rename` with no argument
  prints the current title. Titles are ezio-owned, persisted across runs, and
  shown in the `/resume` list in place of `firstPrompt`. No hax change.
- `/resume` opens an **arrow-key picker** of this folder's past sessions (titles
  merged in) and, on selection, switches the live session to it. Works in both
  standalone and mounted panes.
- **One source of truth.** Both commands live in the shared `SlashController`
  built-in set; the picker and title-merge logic live in published `@ai-ezio/*`
  packages so the downstream adapter imports one copy.
- **No hax (C engine) change.** Resume reuses hax's existing `--resume=ID` spawn
  flag and `--list-sessions` seam; rename is a pure TS sidecar.

## Non-goals

- Renaming a session other than the current one (e.g. an in-picker `r` to rename a
  highlighted row) — deferred. `/rename` only ever titles the current session.
- Persisting titles into hax (a hax-native title field) — explicitly rejected to
  keep the fork minimal/rebaseable (the "extend hax only when absolutely
  necessary" decision). Titles stay an ezio sidecar.
- Resuming sessions from another working directory. `--list-sessions` is
  cwd-scoped; `/resume` lists only this folder's sessions, matching the startup
  picker. Unchanged.
- Auto-pruning the title sidecar. Out of scope; noted as future work.
- `/resume` while a turn is in flight — guarded (see §4), not supported.

## Architecture overview

Both commands are added to `builtinCommands()` in `@ai-ezio/surface`'s `slash.ts`,
so they appear in both surfaces through the existing shared `SlashController`.
Each needs new **optional** `SlashContext` capabilities; a command degrades to a
clean "unavailable" message in any runtime that does not wire them.

New `SlashContext` capabilities:

| Capability | Used by | Standalone source | Mounted source |
|---|---|---|---|
| `currentSessionId(): string \| undefined` | `/rename`, `/resume` | the §1C tracker in `standalone-runtime.ts` (seed from `ready`, refresh via `status()` after `new_conversation` and on first-turn materialization) | the same §1C tracker in the adapter's `onEvent` + post-`/new` `status()` query |
| `getSessionTitle(): string \| undefined` / `setSessionTitle(title): void` | `/rename` | harness title store + the §1C tracker (id may be `undefined` ⇒ pending-rename buffer, §2) | same store + tracker |
| `resume(): Promise<void>` | `/resume` | runtime thunk: `spawnListSessions` + line-reader suspend/restore + `Session.resume` | runtime thunk: `spawnListSessions` + the new `runInteractiveOverlay` seam + `Session.resume` |

The heavy work is the `resume()` thunk: it needs a raw key stream (per-mode) and
an engine respawn (a new harness method). Four structural pieces support it: a
title store (§1A), a relocated/generalized picker (§1B), a session-id acquisition
rule (§1C — without which `/rename` targets the wrong session, see the hax id
materialization note there), and `Session.resume` plus a mounted raw-input overlay
seam (§3).

## §1 — Shared pieces

### §1A — Session title store (`@ai-ezio/harness`)

New module `packages/harness/src/session-titles.ts`. A flat JSON map persisted to
`$XDG_STATE_HOME/ai-ezio/session-titles.json` (falling back to
`$HOME/.local/state/ai-ezio/...` when `XDG_STATE_HOME` is unset, matching how the
codebase resolves state paths):

```jsonc
{ "<sessionId>": { "title": "wire resume seam", "updatedAt": 1718700000000 } }
```

Session ids are uuids (globally unique), so a single un-scoped file is sufficient;
no per-cwd partitioning is needed. API (all small, `fs` injected for tests, write
is atomic — write-temp-then-rename):

```ts
export interface SessionTitleStore {
	getTitle(sessionId: string): string | undefined;
	setTitle(sessionId: string, title: string): void;
	loadTitles(): Map<string, string>; // id → title, for the picker merge
}
```

It lives in `@ai-ezio/harness` (session-state-adjacent; both runtimes already
depend on harness). `setTitle` trims input; an empty string is ignored (a no-op) —
`/rename` never calls `setTitle` with an empty value (§2 prints the current title
instead), and clearing a title is not a goal. The store has no knowledge of the
picker or commands — pure persistence.

### §1B — Reusable picker (`@ai-ezio/surface`)

The pure picker currently lives in `packages/cli/src/repl/resume-picker.ts`
(`parseSessions`, `formatRelativeTime`, `formatRow`, `decodeChunk`, `applyKey`,
`renderFrame`, `runResumePicker`). The cli is not importable by the downstream
ai-whisper adapter, so move the **pure, injected-dependency** parts into
`@ai-ezio/surface` (e.g. `packages/surface/src/resume-picker.ts`) and export them
from surface's index. This mirrors the §1 relocation the predecessor spec did for
`slash.ts` / `skills.ts` / `clipboard.ts` / `transcript-view.ts`.

- The **impure** `spawnListSessions` (spawns `hax --list-sessions` via
  `child_process`) stays out of surface and is provided per-runtime.
- Add a **title merge**: the row's display text becomes
  `loadTitles().get(row.id) ?? firstPrompt ?? "(no prompt)"`. `formatRow` gains an
  optional title argument (or the caller pre-resolves it); `SessionRow` is unchanged
  on the wire — the title is layered in at render time so the merge stays pure.
- `@ai-ezio/cli`'s existing startup `--resume` path repoints its imports to surface
  and gains the same title merge for free. Its picker tests move with the module.

Surface needs no new package dependency (the picker is already pure given injected
`keys` / `write` / `now` / `setRawMode`).

### §1C — Current session id acquisition

`/rename` keys the title store by the current session id, and `/resume` uses it to
skip the active session — so both depend on the runtime knowing the live session's
id. hax does **not** make that trivial, and the naive "track the id from
`ready`/`status`" rule is wrong in two ways:

1. **A fresh, never-written session reports no id.** `session_log_resume_hint()`
   returns `NULL` until the log header is on disk (`header_written`), and
   `ready`/`status` serialize a missing id as the literal `"unknown"`
   (`vendor/hax/src/session.c:493-502`, `vendor/hax/src/protocol/emit.c:77-83` and
   `:427-439`). hax materializes the file lazily — the id only becomes real once
   the session has written a turn.
2. **`/new` rotates the session without announcing it.** `new_conversation` resets
   to a fresh session log but emits only `idle`, never a new `ready` or `status`
   (`vendor/hax/src/agent.c:599-612` and `:1008-1011`). A tracker that listens only
   for `ready`/`status` keeps the *previous* session's id after `/new`, so a
   following `/rename` would title the wrong session.

The acquisition rule (no hax change — all harness/runtime behavior):

- The runtime maintains `currentSessionId: string | undefined`, with hax's
  `"unknown"` **normalized to `undefined`** so callers never key on the sentinel.
- **Seeded** from the `ready` event at start and after each `Session.resume`.
- **Refreshed by issuing an explicit `Session.status()` control** (which re-reads
  the live id) at the two points events alone do not cover: (a) immediately after
  `newConversation()` resolves — re-binding to the rotated session after `/new`;
  and (b) on each turn-settling `idle` while the tracked id is still `undefined` —
  capturing the id the instant the first turn materializes the session file. Once a
  real id is captured, (b) stops firing.
- `status()` here is the concrete harness `Session.status()` (its `StatusEvent`
  carries `sessionId`), distinct from the narrowed `SlashSession.status()` facet
  `/status` uses. Standalone calls it on the `Session` directly; the mounted
  adapter tracks `ready`/`status` in `onEvent` and additionally issues a `status()`
  after `new_conversation`.

This single tracker backs the `currentSessionId()` capability both commands use.

## §2 — `/rename`

Command definition in `slash.ts` (added to `builtinCommands`):

```
name: "rename"
summary: "set a friendly title for this session (shown in /resume)"
```

`run(ctx, args)`:

1. If `ctx.setSessionTitle` is unwired → write `rename unavailable\n` and return.
2. `const title = args.trim()`.
3. Empty (`/rename` with no argument) → write the effective current title — the
   buffered pending title (below) if one is queued, else `ctx.getSessionTitle()` —
   or `no title set · usage: /rename <text>\n` when neither exists.
4. Non-empty → `ctx.setSessionTitle(title)`; echo `— renamed to "<title>" —\n`.

`setSessionTitle(title)` is wired per-runtime over the §1A store and the §1C
tracker, and **must handle the unmaterialized-id case** so the "title a brand-new
session" requirement holds without a hax change:

- **Current id known** (`currentSessionId()` defined) → write the store
  immediately under that id; the title surfaces in the next `/resume` list. No
  engine round-trip.
- **Current id not yet materialized** (`undefined` — a brand-new session with no
  turns, §1C) → buffer the title as a **pending rename** in the runtime
  (in-memory), never writing under the `"unknown"` sentinel. When §1C's first-turn
  `status()` materializes the real id, the runtime flushes the pending title to the
  store under that id and clears the buffer. The title is therefore accepted
  immediately and lands under the real id as soon as one exists.
- **`/new` clears any pending rename** — the buffered title belonged to the prior
  (now-rotated) conversation; a fresh conversation starts untitled.

## §3 — `/resume`

Command definition in `slash.ts`:

```
name: "resume"
summary: "switch to a past session in this folder"
```

`run(ctx)` is intentionally thin: if `ctx.resume` is wired, `await ctx.resume()`;
otherwise write `resume unavailable\n`. All raw-input and respawn mechanics live in
the runtime-owned `resume()` thunk, because both differ per mode.

### The `resume()` flow (shared orchestration, per-mode primitives)

The orchestration is a shared helper (in `@ai-ezio/surface`, alongside the picker)
parameterized by injected primitives so both runtimes share the control flow:

1. **Busy guard.** If a turn is in flight, write
   `finish or interrupt the current turn first\n` and return (no respawn). See §4
   for how "busy" is determined per mode.
2. **List.** `spawnListSessions()` → `parseSessions` → merge titles from the §1A
   store.
3. **Exclude the active session.** Filter out the row whose `id ===
   currentSessionId()` (when an id is materialized — §1C; if the id is still
   `undefined`, nothing is excluded). Resuming the session you are already in is a
   pointless respawn, so it must never be offered. If the filtered list is empty —
   there are no sessions, or the only one is the active session — write `no other
   sessions in this folder\n` and return. (The empty-list message keys off the
   *post-filter* count, so "only the current session exists" takes this path.)
4. **Pick.** Run the arrow picker (`runResumePicker`, now in surface) over a **raw
   key stream** provided by the runtime. Cancel (Esc / `q` / Ctrl-C / EOF) →
   no-op return.
5. **Switch.** Chosen id → `Session.resume(id)` (engine respawn) → per-runtime
   post-respawn re-wiring.

### Raw key stream — the per-mode split

- **Standalone** (`standalone-runtime.ts`): suspend the line reader, flip stdin to
  raw, feed the picker, then restore — the *same* suspend/restore the Ctrl+T
  `/transcript` view already performs. No new contract; reuse the existing
  input-reader seam.
- **Mounted**: ai-whisper's runtime owns the pane's stdin (a modal line reader),
  so the adapter cannot grab it directly. Add **one new optional method** to
  `InteractiveSessionController` (`@ai-whisper/shared/src/interactive-session.ts`),
  mirroring the existing optional `tryConsumeLocalCommand`:

  ```ts
  /** Run an interactive full-screen overlay (e.g. the /resume picker) that needs
   *  raw keystrokes. The host suspends its line reader, switches stdin to raw,
   *  invokes `run` with a raw key stream + write + raw-mode control, then restores
   *  cooked mode and the line reader. Adapters that need no overlay omit it. */
  runInteractiveOverlay?(
  	run: (io: {
  		keys: AsyncIterable<string>;
  		write(s: string): void;
  		setRawMode(on: boolean): void;
  	}) => Promise<void>,
  ): Promise<void>;
  ```

  `@ai-whisper/cli`'s `live-session.ts` implements it: pause the modal line reader,
  put stdin in raw mode, expose stdin chunks as an async iterable, await `run`
  (the picker), then restore. The ezio adapter's `resume()` thunk calls it; the
  picker consumes `io.keys` / `io.write` / `io.setRawMode`. PTY adapters
  (claude/codex) omit the method.

  The overlay is invoked from inside `tryConsumeLocalCommand` (the operator-line
  hook is between turns), so it never races the line reader — the host has already
  delivered the `/resume` line and is awaiting the consume result.

### Engine respawn — `Session.resume(id, options?)` in `@ai-ezio/harness`

`newConversation()` is an in-place `new_conversation` control (same hax child);
`close()` kills the child and latches `closed = true`. Resuming a *different*
session requires a respawn, because hax loads history only at spawn
(`--resume=ID`). Add a method that respawns within the same `Session` object so
the constructor-bound `onEvent` and all consumers stay attached:

```ts
/** Switch this session to a past one: tear down the current hax child, reset
 *  lifecycle state, respawn headless hax with `--resume=ID` plus the prior spawn
 *  options (transcriptPath, protocol/mount flags), and await the new `ready`. The
 *  constructor-bound onEvent stays attached, so the event pump continues. Rejects
 *  (leaving the engine closed) on spawn/protocol failure — the caller surfaces it
 *  and exits (§4). Refuses while a turn holds the gate. */
async resume(sessionId: string, options?: SpawnHaxOptions): Promise<ReadyEvent>;
```

Implementation notes:

- **Acquire the turn gate** (or reject if held) so a resume can never race a turn.
  Because a resume runs between turns (the §4 busy guard) and holds the gate
  exclusively, no turn waiters exist while it executes.
- **Generation-stamp the event pump.** `start()`'s pump is fire-and-forget: it
  loops `for await (event of transport.events())` and, in its `finally`, sets
  `ended = true`, flushes `idleHooks`, and drains `waiters` / `exclusiveWaiters`
  with `deliver(null)` (`packages/harness/src/session.ts:242-253`). A respawn that
  reused the same `Session` while the *old* child's pump was still unwinding would
  let that stale EOF mark the freshly-respawned session `ended` or resolve its new
  waiters with `null` — corrupting it. Guard against this: bump a `this.generation`
  counter on every spawn (start + resume), capture `const gen = this.generation` in
  the pump closure, and have **both `deliver()` and the pump's `finally`
  early-return when `gen !== this.generation`** — a prior generation's events and
  EOF are then inert.
- **Quiesce the old pump before clearing latches.** `close()` only closes the
  transport and kills the child synchronously
  (`packages/harness/src/session.ts:476-488`); the pump's `finally` runs later, when
  fd-3 reaches EOF. So `resume()` proceeds in strict order: (1) `close()` the current
  child + transport; (2) **await the old pump's termination** — expose a `pumpDone`
  promise that resolves when its `finally` completes — so the old generation is fully
  unwound; (3) **reset the lifecycle latches** (`closed`, `ended`, `ready`,
  `waiters`, `exclusiveWaiters`, `idleHooks`) so the same object is reusable (today
  `close()` latches `closed` permanently; resume must clear it); (4) bump
  `generation` and respawn. Awaiting `pumpDone` is the primary ordering guarantee;
  the generation guard is defense-in-depth for any late event that slips through
  before EOF.
- **Refactor:** factor `start()`'s spawn + pump-launch + `ready`-gate logic into a
  shared private helper that both `start()` and `resume()` call, so the pump is
  generation-stamped in exactly one place and the two entry points cannot drift.
- Respawn with `args: ["--resume=" + sessionId]` appended after the protocol/mount
  flags, reusing the prior `transcriptPath`. hax replays history over the protocol
  even under `--mount-mode` (per the resume predecessor).
- On spawn/protocol failure the method rejects with the engine left closed; the
  caller surfaces it and exits (§4).
- Return the new `ready` (its `sessionId` is the resumed id; consumers update their
  tracked `currentSessionId`).

### Post-respawn re-wiring (per runtime, after `resume()` resolves)

- Re-register MCP delegated tools with the respawned engine (re-run the
  `host.start(session)` / register sequence — the same one used at boot).
- Re-point the compactor driver at the resumed session.
- Re-render the surface banner for the resumed session (standalone banner /
  mounted renderer banner).
- Update tracked `currentSessionId` from the new `ready`.

Standalone and the adapter each own their few lines of re-wiring; the respawn
itself is single-sourced in the harness.

## §4 — Edge cases & guards

- **Busy guard.** `/resume` is refused while a turn is in flight (a respawn would
  drop the in-flight turn). Standalone determines "busy" from its REPL turn state;
  mounted from the adapter (a turn is between `assistant_turn_started` and its
  settling `idle`). `Session.resume` also rejects if the turn gate is held, as a
  backstop.
- **Picker cancel / empty list** → clean no-op with a one-line note; the current
  session is untouched. The empty-list path is reached both when no sessions exist
  and when the **only** session is the active one (excluded per §3 step 3) — in both
  cases `/resume` reports "no other sessions" and never opens the picker.
- **Respawn failure** (bad id, hax spawn error, protocol-version mismatch) — the
  old session is already closed and cannot be revived in place. Behavior:
  **report and exit cleanly.** Write `resume failed: <reason>\n`, then let the
  normal engine-exit path tear the REPL (standalone) or pane (mounted) down; the
  closed prior session is safe on disk and re-resumable on relaunch. No fresh
  fallback conversation is spawned (decision: predictable over forgiving).
- **Rename of a brand-new session** with no turns yet: its id is not materialized
  (§1C), so `/rename` buffers the title as a pending rename and flushes it to the
  store under the real id on the first turn. hax also does not list the session in
  `--list-sessions` until it has content, so the titled row appears once the session
  has a turn — by which point the pending title has been flushed. Known and
  acceptable.
- **`/rename` after `/new`** titles the rotated session, not the prior one: §1C
  re-queries `status()` after `new_conversation`, so `currentSessionId()` rebinds to
  the fresh session before the next `/rename` (and a pending rename, if any, is
  cleared by `/new`).
- **Title sidecar growth** is unbounded; pruning is out of scope (future work).
- **cwd scoping:** `/resume` lists only the current folder's sessions (unchanged
  `--list-sessions` behavior).

## §5 — Error handling

- A command's `run()` throwing is caught by `SlashController` (existing behavior):
  it writes `/<name> failed: <message>` and reports `handled`. The REPL/pane never
  crashes on a command failure.
- `setSessionTitle` write failure (fs error) is caught and surfaced as
  `rename failed: <message>`; the in-memory session is unaffected.
- `spawnListSessions` failure degrades to an empty list (resolves `"[]"`), so
  `/resume` reports "no other sessions" rather than throwing — matching the
  startup picker's existing tolerance.
- The respawn-failure path is the one place a command can end the session; it is
  the explicit §4 decision, not an uncaught error.

## §6 — Testing

- **Title store (harness):** `getTitle` / `setTitle` round-trip with injected fs;
  atomic write (temp+rename); empty/whitespace title is a no-op; missing file →
  empty map; malformed JSON → empty map (tolerant).
- **Picker + merge (surface):** title merge into row display (titled id shows
  title, untitled shows `firstPrompt`, neither shows `(no prompt)`); existing
  key-handling / parse / render tests move with the module and still pass.
- **`/rename` (surface):** via a fake `SlashContext` — `setSessionTitle` unwired →
  `rename unavailable`; no-arg with/without an existing or pending title (prints the
  effective title or the `no title set` usage line); non-empty calls
  `setSessionTitle` and echoes the confirmation.
- **§1C tracker + pending rename (runtime — standalone-runtime + adapter):** the id
  tracker normalizes hax's `"unknown"` to `undefined`; it seeds from `ready`,
  re-queries `status()` after `newConversation()` so a **`/new` then `/rename`
  titles the rotated session** (not the prior id — finding 2), and materializes the
  id on the **first-turn `idle`** for a session that started `"unknown"` (finding 1).
  A `/rename` issued while the id is `undefined` buffers a pending title; assert it
  is **flushed to the store under the real id once materialized**, that `/new` clears
  a pending title, and that no title is ever written under the `"unknown"` sentinel.
- **`/resume` (surface):** the shared flow helper with injected primitives —
  busy-guard branch, empty-list branch, cancel branch, and select → `resume(id)`
  called with the chosen id; `resume` unavailable when unwired. **Active-session
  exclusion:** with a list whose ids include `currentSessionId()`, assert that row
  is filtered out before the picker renders (it is never selectable); and when the
  active session is the **only** entry, the flow takes the empty-list "no other
  sessions" path and never opens the picker. A `currentSessionId()` of `undefined`
  excludes nothing.
- **`Session.resume` (harness):** against the **real hax engine**
  (`HAX_PROVIDER=mock`) + a seeded session — assert history replays after resume,
  a post-resume turn succeeds, the lifecycle latches reset (a second resume works),
  and a resume is rejected while the gate is held. **Stale old-pump EOF race
  (finding 3):** with a delayed old-child EOF (e.g. an injectable transport whose
  `events()` iterator completes *after* the respawn), assert the old generation's
  `finally`/`deliver(null)` does **not** mark the respawned session `ended` or
  resolve its new waiters with `null` — i.e. the generation guard + `pumpDone`
  await hold, and a turn submitted after resume still settles normally.
- **Standalone runtime (cli):** the `resume` thunk wires the line-reader
  suspend/restore + respawn re-wiring; rename writes the store (the id-tracker
  specifics are covered by the §1C bullet above).
- **Mounted overlay (ai-whisper):** `live-session.ts` `runInteractiveOverlay`
  suspends the line reader, feeds raw chunks to the async iterable, and restores
  cooked mode + the line reader afterward (assert order via a fake stdin/tty).
- **Adapter (ai-whisper):** the mounted `SlashContext` wires `currentSessionId`,
  the title store, and the `resume` thunk (via the overlay); an e2e drives
  `/rename` then `/resume` through the real harness + a mock engine in a mounted
  pane and asserts the round-trip (title persisted, session switched, banner
  re-rendered).

## §7 — Blast radius & staging

Spans two repos. Because ai-whisper bundles the ezio packages at its own build
time (esbuild, `file:` deps), the ai-ezio changes land first and are then picked
up by a whisper rebuild.

- **Stage 1 — `ai-ezio` (harness + surface):** add the title store
  (`session-titles.ts`); relocate/generalize the picker into `@ai-ezio/surface`
  with the title merge; add `Session.resume`; add the `/resume` + `/rename`
  commands and the new optional `SlashContext` capabilities to `slash.ts`. Move
  the picker tests. Self-contained; standalone gains the commands.
- **Stage 2 — `ai-ezio` (cli wiring):** in `standalone-runtime.ts`, track
  `currentSessionId`, wire the title-store capabilities, and build the `resume`
  thunk (suspend/restore line reader + `spawnListSessions` + `Session.resume` +
  post-respawn re-wiring); repoint the startup picker imports to surface.
- **Stage 3 — `ai-whisper`:** add the optional `runInteractiveOverlay` to
  `InteractiveSessionController`; implement it in `live-session.ts`; widen the
  adapter's `AiEzioEngineSession` facet with `resume`; in
  `create-ai-ezio-live-session.ts` track `currentSessionId`, wire the title-store
  capabilities and the `resume` thunk (via the overlay), and re-do the
  post-respawn wiring (host re-register, driver re-point, banner re-render).

Each stage exceeds three files, so the implementation plan stages them accordingly
(per the repo's small-task discipline).

**Rollout note (stale-bundle gotcha).** Shipping the ai-ezio changes does not by
itself change mounted behavior: a mounted collab runs the globally installed
`whisper`, whose bundle is a frozen snapshot of the ezio packages as of whisper's
last build. To propagate: in `ai-whisper`, run `pnpm install` (refresh the `file:`
ezio deps) and `pnpm -r build` (re-bundle), reinstall the global `whisper`, and
restart the collab.

## File & module boundaries

**ai-ezio**
- `packages/harness/src/session-titles.ts` (new) + test — the title store
- `packages/harness/src/session.ts` — add `Session.resume(id, options?)` (respawn
  + lifecycle-latch reset) + test
- `packages/surface/src/resume-picker.ts` (moved from cli; title merge) + test
- `packages/surface/src/slash.ts` — add `/resume` + `/rename`, new `SlashContext`
  capabilities + test
- `packages/surface/src/index.ts` — export the relocated picker
- `packages/cli/src/repl/standalone-runtime.ts` — track `currentSessionId`, wire
  title/resume capabilities, build the `resume` thunk
- `packages/cli/src/repl/resume-picker.ts` — reduce to a re-export / repoint the
  startup picker to surface

**ai-whisper**
- `packages/shared/src/interactive-session.ts` — optional `runInteractiveOverlay`
- `packages/cli/src/runtime/live-session.ts` — implement the overlay (suspend
  line reader → raw stdin async iterable → restore) + test
- `packages/adapter-ai-ezio/src/ai-ezio-engine.ts` — widen the engine facet with
  `resume`
- `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts` — track
  `currentSessionId`, wire title/resume capabilities, the `resume` thunk via the
  overlay, and post-respawn re-wiring
- `docs/superpowers/specs/2026-06-18-ezio-resume-rename-commands-pointer.md` — a
  one-line pointer back to this canonical spec
