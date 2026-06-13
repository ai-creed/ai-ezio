# ezio mounted-mode slash commands — design

**Status:** approved (brainstorm)
**Date:** 2026-06-14
**Scope:** ai-whisper's mounted ezio (the `@ai-whisper/adapter-ai-ezio` adapter +
the mount runtime in `@ai-whisper/cli`), plus a supporting relocation in
`@ai-ezio/surface`. Spans two repos; see §6.
**Predecessor:** `2026-06-08-ezio-slash-commands-design.md` — this is the
mounted-mode follow-up that spec explicitly deferred ("Non-goal: Mounted-mode
slash interception — out of scope now").

## Motivation

Slash commands do not work inside a mounted ezio (`whisper collab mount ezio`).
The cause is the same structural one the standalone spec fixed, surfacing again
because mounted mode bypasses ezio's standalone REPL entirely:

1. **No `SlashController` in the mounted path.** Slash dispatch lives only in
   `@ai-ezio/cli`'s standalone runtime (`packages/cli/src/repl/standalone-runtime.ts`
   builds a `SlashController` and routes every line through it). In mounted mode
   the whisper host owns the terminal and feeds operator lines straight to the
   harness `Session` via the adapter's `writeUserInput` → `session.submit`. There
   is no controller in that path.
2. **The line ships to headless hax as a normal turn.** hax then runs its native
   TUI `slash_dispatch`; when the line *is* a command it is handled locally and
   the agent loop `continue`s without emitting any protocol event, so the mounted
   host (parked on the protocol) hangs — and hax's command output writes to fd 1,
   which is `ignored` in a mounted spawn, so it prints to nowhere.

The standalone spec already built the fix as **reusable, injected-dependency
pieces** (`classifyLine`, `SlashController`) precisely so the mounted adapter
could adopt them "later without change." This is that adoption.

## Goals

- The full standalone slash-command set works in a mounted ezio pane, **minus
  `/quit` and `/exit`** (session lifecycle is owned by the whisper host, not
  ezio — deferred, to be re-evaluated later). Mounted set: `/help`, `/new`
  (alias `/clear`), `/status`, `/skills`, `/copy`, `/usage`, `/transcript`,
  `/compact`.
- **One source of truth.** The same `SlashController` + `classifyLine` serve
  standalone and mounted; adding a command in one place reaches both surfaces.
- **Operator-only interception.** Only a human-typed operator line is intercepted.
  Relayed/injected turns from other collaborators are never treated as commands.
- A submitted command never reaches hax and never hangs the pane.

## Non-goals

- `/quit`, `/exit` in mounted mode (lifecycle semantics in a collab — deferred).
- Changing the standalone REPL's behavior. The relocation in §1 is import-only
  for standalone; its observable behavior is unchanged.
- Any hax (C engine) change. This is pure TS harness + adapter + host work.
- A new MCP/protocol control. Commands reuse existing harness capabilities.

## Architecture overview

Chosen approach (of three weighed in brainstorming): **adapter-owned dispatch,
host asks.** The whisper host stays agnostic of ezio's command vocabulary; it
only asks the adapter "did you consume this operator line?" The alternatives —
the host re-implementing dispatch (duplicates `classifyLine`/registry, couples
whisper to ezio's command set) and a two-input-method split (overloads the input
contract with a source distinction) — were rejected as less clean.

Three structural parts:

1. **Relocation** (`@ai-ezio/surface`) — move the slash machinery and its helpers
   into the shared surface package so both standalone cli and the whisper adapter
   import one copy.
2. **Seam** (`@ai-whisper/shared` + `@ai-whisper/adapter-ai-ezio`) — an optional
   `tryConsumeLocalCommand` method on `InteractiveSessionController`, implemented
   by the ezio adapter (which constructs a `SlashController` with mounted
   capabilities) and absent on the PTY adapters.
3. **Host hook** (`@ai-whisper/cli`) — call the seam at the one operator-line
   boundary in `live-session.ts`, before the line is echoed and submitted.

## §1 — Relocation to `@ai-ezio/surface`

Move four modules from `@ai-ezio/cli` to `@ai-ezio/surface` and export them from
surface's index:

| From (`@ai-ezio/cli`) | To (`@ai-ezio/surface`) |
|---|---|
| `src/repl/slash.ts` | `src/slash.ts` |
| `src/skills.ts` | `src/skills.ts` |
| `src/repl/clipboard.ts` | `src/clipboard.ts` |
| `src/repl/transcript-view.ts` | `src/transcript-view.ts` |

`@ai-ezio/cli` already declares `@ai-ezio/surface` as a dependency (devDep,
esbuild-bundled) and already imports from it (`createMountedRenderer`), so cli
simply repoints these imports. Their unit tests move with them into surface.

**Dependency hygiene.** `slash.ts` currently imports `Pick<Session, …>` (harness)
and `Pick<SessionRecorder, …>` (session-recorder) for its `SlashContext`. On the
move, replace those concrete type references with **local structural interfaces**
declared in `slash.ts`:

```ts
interface SlashSession {
	newConversation(): Promise<void>;
	status(): Promise<{ provider: string; model: string; effort?: string }>;
}
interface SlashRecorder { noteNewConversation(): void; }
```

Surface then needs **no new package dependency** (it keeps `@ai-ezio/protocol`,
which it already has, for the `AssistantTurnFinishedEvent["usage"]` type). No
dependency cycle is introduced (`harness`/`session-recorder` do not depend on
`surface`). Standalone's `standalone-runtime.ts` passes the same concrete objects
it does today; they satisfy the structural interfaces.

This relocation is a clean-up valuable on its own: it removes a cli-only island
and puts terminal-UX helpers in the terminal-UX package.

**Configurable built-in set (mounted exclusion of `/quit` & `/exit`).** Today
`SlashController`'s constructor unconditionally registers every built-in —
including `quit` (alias `exit`) — and `handle()` maps `quit` to the `exit`
outcome *before* running command logic. Mounted mode must omit those two while
reusing the *same* controller (one source of truth), so the controller needs a
construction-time way to drop them. Add an optional second constructor argument:

```ts
class SlashController {
	constructor(ctx: SlashContext, opts?: { excludeCommands?: readonly string[] });
}
```

The constructor skips registering any built-in whose canonical `name` appears in
`excludeCommands`; because `register()` adds a command together with its aliases,
excluding the canonical `quit` drops its `exit` alias with it. Standalone keeps
`new SlashController(ctx)` (default — `quit`/`exit` present, `/quit` exits). The
mounted adapter constructs `new SlashController(ctx, { excludeCommands: ["quit"] })`.
A mounted `/quit` or `/exit` then misses the registry, so `classifyLine` returns
`unknown` and the controller emits the standard "unknown command" message —
consumed locally, never submitted, and never reaching the `exit` branch in
`handle()`. The exclusion is a construction-time parameter, not a forked command
set, so the built-in definitions stay single-sourced.

## §2 — The adapter seam + host wiring

### Seam

Add one optional method to `InteractiveSessionController`
(`@ai-whisper/shared/src/interactive-session.ts`), mirroring the existing optional
`echoUserInput`:

```ts
/** Try to handle an operator-typed line as a local session command (e.g. /compact).
 *  Returns true if the line was consumed (handled and rendered locally; the host
 *  must NOT submit it as a turn). Returns false for ordinary input. Adapters that
 *  do not implement local commands omit this method. */
tryConsumeLocalCommand?(line: string): Promise<boolean>;
```

- **ezio adapter** (`create-ai-ezio-live-session.ts`) implements it: it constructs
  a `SlashController` once (capabilities in §3), and per call runs the controller,
  rendering output to the pane. It returns `true` when the line classifies as a
  command **or** an unknown command (both are handled locally — an unknown command
  prints "unknown command" and must not be submitted), and `false` when the line
  is plain text / path-like / multiline (which `classifyLine` already maps to
  `submit`).
- **claude/codex adapters** do not implement it. The method is absent → the host
  passes their slashes through to the PTY child, which owns its own slash UX.

The controller's `SlashOutcome` maps to the boolean as: `handled` → `true`;
`submit` → `false`. The `exit` outcome is unreachable because the mounted
controller is built with `excludeCommands: ["quit"]` (§1), so no `quit`/`exit`
command exists to produce it.

### Host hook

The operator-line boundary is in `@ai-whisper/cli`'s `live-session.ts`, inside the
line-buffered input path (the `\r`/`\n` branch around lines 154-178). Today it
echoes the line as the magenta `▌ ` stripe and calls
`interactiveSession.writeUserInput(completed)`. Insert the consume check **before**
both:

```ts
const completed = inputLineBuffer;
inputLineBuffer = "";
if (
	completed.length > 0 &&
	(await input.interactiveSession.tryConsumeLocalCommand?.(completed))
) {
	continue; // handled locally: no echo-stripe, no writeUserInput, no turn
}
// …existing echo-stripe + writeUserInput(completed)…
```

This site only ever receives **operator** input read from `process.stdin`
(line-buffered because the ezio target sets `lineBufferedInput`). Relayed and
injected agent turns reach `writeUserInput` through other call sites
(`mount-session-main.ts`'s `writeInjectedInput`, the turn-owned relay) and never
pass through here, so operator-only scoping is structural, not a runtime guard.
The invariant is that `tryConsumeLocalCommand` has **exactly one call site** — this
operator-line hook. Because the injected paths reach `writeUserInput` without ever
crossing this hook, the operator-only property is guarded at the injected-input
layer, not in `live-session.ts` (§6) — a `live-session.ts` test cannot observe the
injected path at all and would pass vacuously.

(The existing `externalInputRouter.handleInput` hook, which already intercepts
`@@` relay directives from operator input, is the precedent for handling an
operator line locally instead of submitting it.)

## §3 — Mounted `SlashContext` capabilities

The adapter assembles the same `SlashContext` that
`standalone-runtime.ts:237-253` builds, sourced from mounted pieces:

| Capability | Mounted source |
|---|---|
| `write` | `input.stdout.write` (the pane) |
| `session` | **widen `AiEzioEngineSession`** with `newConversation()`, `status()`, and `transcriptPath` — the real hax `Session` already implements these; only the narrowed adapter facet omits them |
| `recorder?` | **omitted** — mounted mode has no session recorder; the cap is optional and `/new` works without it |
| `compactor` | the existing `AutoCompactDriver` — `driver.compactNow()` already exists and is wired in mounted mode; its `CompactOutcome` matches the `{ kind; reason? }` shape `/compact` expects |
| `lastContent` / `lastUsage` | **two new persistent locals** in the adapter's `onEvent`, tracked from `assistant_turn_finished.content` / `.usage` (distinct from the existing transient `pendingContent`, which is nulled on idle) |
| `skills` | `discoverSkills` (now imported from surface) |
| `clipboard` | `makeClipboard` (now imported from surface) |
| `showTranscript` | `renderTranscript` (now imported from surface) — see §4 for the two mounted-specific requirements |

The controller is constructed once in `createAiEzioLiveSession`, after the session
and driver exist (it closes over them), and exposed through
`tryConsumeLocalCommand`.

## §4 — Command set & edge behavior

**Mounted set:** `/help`, `/new` (alias `/clear`), `/status`, `/skills`, `/copy`,
`/usage`, `/transcript`, `/compact`.

- **`/quit`, `/exit`** — not registered in mounted mode. The adapter builds the
  controller with `excludeCommands: ["quit"]` (§1), which drops `quit` and its
  `exit` alias from the registry. Typing `/quit` or `/exit` then falls to the
  standard local "unknown command: /quit. type /help for the list." message —
  handled locally, never submitted, and never an exit. (Decision: plain
  unknown-command message rather than a tailored "not available in mounted mode"
  line — simpler, and re-evaluated when lifecycle commands are designed.)
- **`/transcript`** requires two mounted-specific bits:
  1. **Mint a `HAX_TRANSCRIPT` path at mounted session start.** The adapter's
     `session.start()` passes no `transcriptPath` today, so no mirror exists. Mint
     a path (as `startWithTranscript` does in standalone) and pass it at start so
     `session.transcriptPath` is populated.
  2. **Dump mode, not a pager.** Render with `interactive: false` so the view
     dumps the mirror to the pane instead of spawning `less` (a child pager would
     fight the relay/composer for the tty). The `transcript-view` module already
     supports a non-interactive dump path.
- **Unknown command** → local message, consumed (never submitted) — same as
  standalone.
- **Path-like / multiline** (`/tmp/foo`, a pasted block beginning with `/`) →
  `classifyLine` returns `submit` → `tryConsumeLocalCommand` returns `false` →
  ordinary turn. Identical semantics to standalone.

## §5 — Error handling

All inherited from `SlashController`, so behavior matches standalone:

- A command's `run()` throws → caught; the controller writes
  `"/<name> failed: <message>"` and reports `handled` (→ `true`). The pane never
  crashes on a command failure.
- An engine-touching command (`/new`, `/status`) after the engine has exited →
  the awaited control rejects; caught by the same guard and surfaced as a failure
  line.
- Clipboard unavailable (`/copy`) → `clipboard()` rejects; `/copy` catches and
  writes `"clipboard unavailable: <message>"`.

## §6 — Testing

- **Relocation (ai-ezio):** the existing `slash.test.ts`, skills, clipboard, and
  transcript-view tests move with their modules into `@ai-ezio/surface` and run
  there. Standalone REPL tests are unchanged except for repointed imports. Add
  `slash.test.ts` coverage for the new `excludeCommands` option: a controller
  built with `{ excludeCommands: ["quit"] }` has no `quit`/`exit` keys, and
  `handle("/quit")` / `handle("/exit")` both return `handled` with the
  unknown-command message (never the `exit` outcome); the default controller
  still maps `/quit` → `exit`.
- **Adapter (ai-whisper):** unit-test `tryConsumeLocalCommand` with a fake session
  and fake driver — a command line → consumed (`true`), rendered, no `submit`; a
  plain line → `false`; an unknown command → consumed (`true`) with the
  unknown-command message. Assert the controller is constructed with
  `excludeCommands: ["quit"]`, so a mounted `/quit` (and `/exit`) is consumed as
  an unknown command (`true`) and never produces an exit. Assert
  `lastContent`/`lastUsage` track `assistant_turn_finished`.
- **Host operator path (ai-whisper):** `live-session.test.ts` — a slash operator
  line is consumed (no `writeUserInput`, no echo-stripe); an ordinary operator
  line still submits.
- **Operator-only guard at the injected-input layer (ai-whisper):**
  `mount-session-main.test.ts` — drive an injected/relayed line through the
  injected path (`writeInjectedInput` → `interactiveSession.writeUserInput`, the
  route the turn-owned relay also uses) and assert it reaches `writeUserInput`
  directly and **never** calls `tryConsumeLocalCommand`. This is the correct layer
  for the operator-only regression guard: relayed/injected input bypasses
  `live-session.ts` entirely, so the same assertion in `live-session.test.ts`
  would pass vacuously and would not catch a future change that wrongly routed
  injected input through the seam. (The structural invariant — one call site —
  is documented in §2.)

## §7 — Blast radius & staging

The work spans two repos. Because ai-whisper bundles the ezio packages at its own
build time (esbuild, `file:` deps), the ai-ezio changes must land first and then
be picked up by a whisper rebuild.

- **Stage 1 — `ai-ezio`:** relocate the four modules to `@ai-ezio/surface`,
  apply the structural-interface decoupling, export from surface's index, repoint
  cli imports, move the tests. Self-contained; standalone behavior unchanged.
- **Stage 2 — `ai-whisper`:** widen `AiEzioEngineSession`; add the optional
  `tryConsumeLocalCommand` to `InteractiveSessionController`; in the ezio adapter,
  build the `SlashController` (with `excludeCommands: ["quit"]`), add
  `lastContent`/`lastUsage` tracking, implement the seam, and add the
  mounted-transcript wiring (mint path at start + dump mode).
- **Stage 3 — `ai-whisper`:** add the `live-session.ts` host hook and its tests,
  plus the operator-only guard test at the injected-input layer
  (`mount-session-main.test.ts`).

Each stage exceeds three files, so the implementation plan stages them
accordingly (per the repo's small-task discipline).

**Rollout note (stale-bundle gotcha).** Shipping the ai-ezio surface change does
not by itself change mounted behavior: a mounted collab runs the globally
installed `whisper`, whose bundle is a frozen snapshot of the ezio packages as of
whisper's last build. To propagate: in `ai-whisper`, run `pnpm install` (refresh
the `file:` ezio deps) and `pnpm -r build` (re-bundle), reinstall the global
`whisper`, and restart the collab.

## File & module boundaries

**ai-ezio**
- `packages/surface/src/slash.ts` (moved; structural interfaces; `excludeCommands` constructor option) + `slash.test.ts`
- `packages/surface/src/skills.ts` (moved) + test
- `packages/surface/src/clipboard.ts` (moved) + test
- `packages/surface/src/transcript-view.ts` (moved) + test
- `packages/surface/src/index.ts` — export the four
- `packages/cli/src/repl/standalone-runtime.ts`, `standalone.ts` — repoint imports

**ai-whisper**
- `packages/shared/src/interactive-session.ts` — optional `tryConsumeLocalCommand`
- `packages/adapter-ai-ezio/src/ai-ezio-engine.ts` — widen the engine facet
- `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts` — build the
  `SlashController`, track `lastContent`/`lastUsage`, implement the seam, mount the
  transcript path
- `packages/cli/src/runtime/live-session.ts` — the operator-line host hook
- `packages/cli/src/runtime/mount-session-main.test.ts` — (test only) operator-only
  guard: injected/relayed input reaches `writeUserInput` without calling
  `tryConsumeLocalCommand`
- `docs/superpowers/specs/2026-06-14-ezio-mounted-slash-commands-pointer.md` — a
  one-line pointer back to this canonical spec
