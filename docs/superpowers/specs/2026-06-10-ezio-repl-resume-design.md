# ezio REPL resume (`--continue` / `--resume`) — design

**Status:** Phase A + Phase B implemented (2026-06-10). Phase B uses the
`hax --list-sessions` seam (option B2, confirmed).
**Date:** 2026-06-10
**Scope:** the `ai-ezio` CLI launcher (`packages/cli`) and the standalone self-mount
runtime. Phase A is harness-only (no hax changes). Phase B adds one minimal,
generic hax seam (`--list-sessions`).

## Motivation

`ai-ezio --continue` (and `--resume`) is the backlog item found during the M11
manual smoke (2026-06-10). Today these are **not** ezio flags: any argv ezio does
not recognize falls through to the raw-hax TUI passthrough at the bottom of
`main()` (`packages/cli/src/cli.ts`). That passthrough resumes a conversation the
*old* way — hax draws its own TUI — **outside the unified architecture**: no MCP
host, no compactor, none of the M7/M8 ezio surface. So resume silently works but
quietly drops every ezio capability, and masquerades as an ezio feature.

The fix is to make resume a first-class ezio self-mount: ezio recognizes the
resume flags, forwards them to the **headless** hax spawn it already owns, and
keeps the full unified stack active.

## Findings (what hax already provides)

Read of `vendor/hax/src/main.c`, `agent.c`, `session.c`:

1. **hax already implements `--continue` and `--resume[=ID]` end to end.**
   `main.c` resolves the session file *before* provider construction
   (`--continue` = newest in this cwd; `--resume=ID` = id/path match;
   bare `--resume` = interactive picker). `agent.c:878-890` loads that history
   into the conversation before anything else touches it (the model gets the full
   prior context on the next turn).

2. **`--mount-mode` does NOT suppress the history load.** It only gates *human
   chrome*: the startup banner (`agent.c:893`) and the "resume with:
   hax --resume=ID" hint line (`agent.c:1401`). The history **load** runs
   regardless of mount mode, so a headless/mounted hax spawned with `--continue`
   or `--resume=ID` resumes the conversation as context — exactly what ezio needs.
   (The `main.c:242` comment "suppresses banner/usage/resume" means the resume
   *hint line*, not the load.)

   **Caveat — the startup *replay* is TTY-only.** `agent.c:909`
   `replay_user_turn()` only *renders* the loaded items (no model call, no history
   mutation) and is guarded by `if (!isatty(STDIN) || !isatty(STDOUT)) return;`
   (`agent.c:737`). Under the self-mount, hax's stdout is `ignore` (not a tty), so
   the replay is a **no-op** — it emits no protocol events (the emitter isn't even
   wired until `agent.c:962`, after the call). So ezio's surface/recorder never see
   the resumed turn: history loads silently. ezio prints its own one-line "resumed"
   notice for feedback (P1). Upside: zero replay events means **no double-capture**
   of resumed history into the recorder/compactor.

3. **The `/resume` slash command is the wrong lever.** It is a full-screen
   interactive TUI picker (`session_picker_run`, raw mode). Under the unified
   architecture ezio owns the terminal and hax's stdin/stdout are `ignored`, so
   the hax picker can neither draw nor read. We therefore adapt the **CLI flags**
   (which hax handles headlessly), not the slash command.

4. **Session storage layout** (for Phase B): sessions live at
   `$XDG_STATE_HOME/hax/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`, where
   `<encoded-cwd>` is a readable slug plus an FNV-1a hash of the full cwd, the
   session id is the `<uuid>`, and line 1 of each file is a JSON header carrying
   `cwd`, provider, model, effort. `session_list()` enumerates a cwd's sessions
   newest-first; `session_first_prompt()` lazily reads a row's opening prompt.

## Goals

- `ai-ezio --continue` (and `-c`) resumes the most recent session in the cwd
  through the **unified self-mount** (MCP host + compactor + M7/M8 surface active).
- `ai-ezio --resume=ID` resumes a specific session the same way.
- `ai-ezio --resume` (no id) presents an **interactive picker** so a human can
  *see and choose* a session without knowing any id (Phase B).
- The remaining raw-hax passthrough degrades **loudly**, not silently.

## Non-goals

- Mid-session `/resume` inside ezio's own REPL (swapping the live session over the
  protocol) — a larger feature, out of scope here.
- A mounted-mode (ai-whisper adapter) resume surface — the harness seam added here
  is reusable, but wiring it downstream is separate.

---

## Phase A — flag interception + self-mount forwarding (harness-only)

Make ezio recognize a bare resume invocation and route it into the existing
`runStandalone` self-mount, forwarding the resume flag to the headless hax spawn.

### Interfaces (`packages/cli/src/cli.ts`, pure + testable)

```ts
export type ResumeIntent =
	| { kind: "continue" }       // -c / --continue: newest session in cwd
	| { kind: "id"; id: string } // --resume=ID: a specific session
	| { kind: "picker" };        // bare --resume / --resume= : choose interactively

/** Parse a resume intent from argv, or undefined when none is present. Pure. */
export function parseResumeIntent(argv: readonly string[]): ResumeIntent | undefined;

/** A *bare* resume invocation (argv is exactly one resume token) eligible for the
 * ezio self-mount. Combined invocations (`-p … --continue`, `--mount-mode …`)
 * return undefined and keep their existing routing. Pure. */
export function resumeSelfMount(argv: readonly string[]): ResumeIntent | undefined;

/** The hax args for a resolved resume intent. `continue`/`id` map to a flag;
 * `picker` has none (resolved in TS). Pure. */
export function resumeHaxArgs(intent: ResumeIntent): string[];
```

`parseResumeIntent` recognizes `-c`, `--continue`, `--resume`, and `--resume=ID`;
`--resume` and `--resume=` (empty) both yield `picker`. `resumeSelfMount` only
fires when argv is a *single* resume token, so it never hijacks `-p … --continue`
(already handled by the one-shot path) or `--mount-mode … --continue` (already
forwarded by the mount path).

### Routing (`main()`)

Inserted after the `wantsInteractiveSelfMount` block, before the `-p` one-shot:

```ts
const resume = resumeSelfMount(argv);
if (resume && process.stdin.isTTY && process.stdout.isTTY) {
	if (resume.kind === "picker") {
		// Phase A: no picker yet — guide the user instead of hanging on hax's
		// TUI picker (which cannot run under the headless mount).
		process.stderr.write(
			"ai-ezio: --resume needs a session id (--resume=ID), or use --continue " +
				"for the most recent.\n         An interactive picker is coming soon.\n",
		);
		return 2;
	}
	const { runStandalone } = await import("./repl/standalone-runtime.js");
	return runStandalone({ resumeArgs: resumeHaxArgs(resume) });
}
```

### Runtime (`packages/cli/src/repl/standalone-runtime.ts`)

`runStandalone` gains an options object and forwards the resume flag to the spawn:

```ts
export interface StandaloneOptions {
	/** Forwarded to the headless hax spawn (e.g. ["--continue"] or
	 * ["--resume=ID"]) to resume a prior session. Absent → fresh session. */
	resumeArgs?: string[];
}

export async function runStandalone(opts: StandaloneOptions = {}): Promise<number> {
	// …
	await session.start(opts.resumeArgs?.length ? { args: opts.resumeArgs } : {});
	// …
}
```

`Session.start({ args })` already appends extra args after the protocol flags
(`spawnHax` → `haxSpawnArgs`), so this is a one-line wiring change. The recorder
and compactor attach via the existing `onEvent`. (Resume emits **no** replay
events — see the Findings caveat — so nothing extra flows through `onEvent` on
resume; the loaded history is silent context for the next turn.)

**Resumed notice (P1).** Because the engine replay is a TTY-only no-op under the
self-mount, ezio prints its own one-line notice when `resumeArgs` is present, so
the user gets feedback that history was loaded:

- `--continue` → `─ resumed most recent session · history loaded as context ─`
- `--resume=ID` → `─ resumed session <id-prefix> · history loaded as context ─`

It is count-free: the precise "N earlier messages" count lives only inside hax and
surfacing it would need a new engine seam, which this design deliberately avoids
(no hax change for P1). `runStandalone` writes the notice (a pure
`resumeNotice(resumeArgs)` helper formats it) after `start()`/`host.start` and
before the REPL loop, so it lands just under the banner.

### Loud passthrough (backlog ask)

On the remaining raw-hax passthrough path (bottom of `main()`), emit a concise
stderr note that the launch runs *outside* the unified stack — skipped for purely
informational flags (`--help`, `-h`, `--version`) so common usage stays clean.

### Edge cases (Phase A)

- **Nothing to continue:** hax warns and starts fresh (`main.c:350`); ezio shows
  it as a normal session. Acceptable.
- **Unknown `--resume=ID`:** hax exits non-zero with "no session matching …";
  ezio surfaces the engine's stderr/exit. The self-mount start rejects cleanly.
- **Non-TTY `--continue`/`--resume=ID`** (piped/CI): falls through to existing
  routing (unchanged); the ezio self-mount requires a terminal.
- **Resume replay:** the engine replay is a TTY-only no-op under the self-mount
  (Findings caveat), so the resumed turn is **not** re-displayed by hax and emits
  no protocol events. ezio shows its own count-free "resumed" notice instead. A
  bonus: with no replay events, resumed history is **not** double-captured into
  the recorder/compactor.
- **Combined flags** (`-p … --continue`, `--mount-mode … --continue`): untouched;
  `resumeSelfMount` returns undefined for multi-token argv.

### Testing (Phase A)

- Pure `parseResumeIntent`: `-c`, `--continue`, `--resume=ID`, bare `--resume`,
  `--resume=` (empty → picker), none, and a non-resume flag.
- Pure `resumeSelfMount`: single token → intent; `["-p","x","--continue"]` →
  undefined; `["--mount-mode","--continue"]` → undefined; `[]` → undefined.
- Pure `resumeHaxArgs`: `continue` → `["--continue"]`; `id` →
  `["--resume=ID"]`; `picker` → `[]`.
- Launch test: `main(["--resume"])` with both TTYs mocked writes the guidance and
  returns `2` without spawning; `main(["--continue"])` routes to a mocked
  `runStandalone` with `resumeArgs: ["--continue"]` (not the raw passthrough).
- Manual smoke: `HAX_PROVIDER=mock ai-ezio` → exit; `ai-ezio --continue` resumes
  prior history with the surface/host active.

---

## Phase B — interactive session picker (better UX)

Session ids are opaque uuids; **no human remembers them, and there is no way to
see them without a picker.** Phase B makes `ai-ezio --resume` (bare) list the
cwd's sessions and let the user choose, then resume the chosen id via the Phase A
path.

### The enumeration decision (needs confirmation)

ezio must learn the cwd's session list. Two options:

- **B1 — replicate hax's storage layout in TS.** ezio re-implements `encode_cwd`
  (slug + FNV-1a hash), reads `$XDG_STATE_HOME/hax/sessions/<encoded-cwd>/`, sorts
  by mtime, and parses each JSONL header + first prompt. **Rejected.** This is a
  downstream peek into hax internals that drifts the moment hax changes its hash,
  filename scheme, or header — exactly the tech-debt the project's "no throwaway
  hacks; prefer the mechanism the product keeps" decision warns against
  (`mem-2026-06-04-…`).

- **B2 — a minimal `hax --list-sessions` seam (recommended).** A tiny,
  generic, non-interactive subcommand that reuses the existing `session_list()` +
  `session_first_prompt()`, prints `[{id, mtime, mtimeNsec, firstPrompt}]` to
  stdout as JSON, and exits 0. No protocol fds, no TUI. ezio shells out,
  parses the JSON, renders **its own** picker, then self-mounts with
  `--resume=ID`. hax stays the single source of truth for its own storage format;
  ezio never replicates the hash or parses JSONL. This honors both standing
  decisions: it is "the mechanism the product keeps," and it is a
  minimal/localized/rebaseable hax extension justified because the capability
  (knowing hax's private session storage) genuinely cannot live cleanly in TS
  (`mem-2026-06-08-… extend hax only when absolutely necessary`).

**Recommendation: B2.** Confirm before implementing Phase B.

### Picker UX (sketch, assuming B2)

- `ai-ezio --resume` (bare, TTY) → `hax --list-sessions` → render a
  numbered/arrow-selectable list: `#  age · "first prompt…"`.
- Reuse ezio's existing raw-mode input plumbing for selection (arrow keys + Enter,
  or a typed number); Esc/Ctrl-C cancels with exit 0.
- On select → `runStandalone({ resumeArgs: ["--resume=<id>"] })` (Phase A path).
- Empty list → "no past sessions in this directory" and exit 0.
- The Phase A "picker coming soon" stderr branch is replaced by this flow.

### Implementation note — the picker → REPL stdin handoff (gotcha)

The picker consumes `process.stdin`, then hands off to `runStandalone`, which
re-iterates the *same* stdin for the REPL. A plain `for await (const chunk of
stdin)` **destroys** the stream when the loop breaks (Node's default async-
iterator behavior), so the picker's selection would EOF the REPL the instant it
mounts — the REPL exits with code 1 before accepting a keystroke. Fix: the
picker's chunk reader iterates with `stdin.iterator({ destroyOnReturn: false })`,
leaving stdin alive for the REPL. Covered by a regression test (`stdinChunks`
leaves the stream alive) and a pty smoke (REPL stays alive + exits cleanly after
a pick, behaviorally identical to the no-picker `--resume=ID` path).

### hax seam (B2) — minimal change

`--list-sessions` is a new `getopt_long` option in `main.c` that: gets cwd, calls
the `session_list_json()` helper (a self-contained, append-only function in
`session.c` reusing `session_list()` + `session_first_prompt()`), prints the JSON
array (jansson), and exits — before any provider/curl init. **JSON is the only
output** — there is no `--json` sub-flag and no human-table mode, since ezio is
the consumer and machine output is all that's needed (keeps the seam minimal). A
human running it gets jq-able JSON. Kept under the UPSTREAM.md discipline
(localized, rebaseable). No change to the agent loop or the protocol.

### Testing (Phase B, when built)

- hax: a unit/e2e asserting `--list-sessions` emits well-formed JSON for a
  seeded session dir and `[]` for an empty cwd.
- ezio: pure render/selection tests for the picker (list formatting, number/arrow
  selection, cancel), with the `--list-sessions` call injected; a launch test that
  a chosen id reaches `runStandalone` as `--resume=<id>`.

---

## Files & module boundaries

Phase A (harness-only):

- `packages/cli/src/cli.ts` — `ResumeIntent`, `parseResumeIntent`,
  `resumeSelfMount`, `resumeHaxArgs`; the `main()` resume branch; loud passthrough.
- `packages/cli/src/cli.test.ts` — pure-predicate tests.
- `packages/cli/src/cli-launch.test.ts` — routing tests (guidance/exit + routed
  resumeArgs).
- `packages/cli/src/repl/standalone-runtime.ts` — `StandaloneOptions` +
  `resumeArgs` forwarding.

Phase B (adds a hax seam):

- `vendor/hax/src/{main.c,session.c,session.h}` — `--list-sessions` (JSON only)
  via the `session_list_json()` helper.
- `packages/cli/src/repl/resume-picker.ts` (+ test) — list parse, render, select.
- `packages/cli/src/cli.ts` — wire the bare-`--resume` branch to the picker.

## Resolved decisions

1. **Phase B enumeration approach.** B2 — the `hax --list-sessions` seam (confirmed
   2026-06-10).
2. **Picker interaction model.** Both: arrow keys (+ `j`/`k`) and 1-9 digit jump,
   Enter to select, Esc/Ctrl-C/`q` to cancel.
3. **`--list-sessions` output (P2, 2026-06-11).** JSON only — no `--json` sub-flag,
   no human table. ezio is the consumer and wants JSON; keeps the seam minimal.
4. **Resume display (P1, 2026-06-11).** The engine replay is a TTY-only no-op under
   the self-mount, so ezio prints its own count-free "resumed" notice; no hax
   change, no recorder double-capture.
