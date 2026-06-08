# ezio-owned slash commands — design

**Status:** approved (brainstorm)
**Date:** 2026-06-08
**Scope:** the standalone self-mount REPL (`packages/cli`). No hax changes.

## Motivation

Slash commands hang ezio's standalone REPL. The cause is structural, not a
one-off bug:

1. **The hang.** In mount mode the agent loop reads a `submit` control, then
   runs `slash_dispatch` on the text (`vendor/hax/src/agent.c:1027`) exactly like
   the interactive path — but when the line *is* a command it is handled locally
   and the loop `continue`s **without emitting any protocol event**.
   `runStandaloneRepl` is parked on `await session.waitForEvent("idle")` after the
   submit, so it blocks forever. (Contrast `/new`'s dedicated
   `EMIT_CTL_NEW_CONVERSATION` path at `agent.c:983`, which explicitly fires
   `on_idle`.)
2. **Dead output.** Every hax slash command writes to **fd 1**, which is
   `ignored` in a mounted/self-mounted spawn (`packages/harness/src/spawn.ts` —
   "the protocol, not the TTY, drives a mounted session"). So even with the hang
   fixed, `/help`, `/usage`, etc. would print to nowhere.

hax's slash commands are a TUI feature that cannot work through the headless
protocol. The architecture says **ezio owns terminal UX**, so slash commands
belong in ezio's TS REPL, rendered by ezio. This also avoids the no-scraping
anti-pattern (AGENTS.md rule #5): we never capture or parse hax's fd 1.

## Goals

- A `/`-command system owned entirely by ezio's standalone REPL, with the full
  command set: `help`, `new` (alias `clear`), `status`, `skills`, `copy`,
  `usage`, `quit` (alias `exit`).
- An **extensible** registry so future harness-purpose commands can be added with
  one `register()` call.
- A submitted `/`-command never reaches hax and never hangs the REPL.
- Typos surface as a local "unknown command" message, not a silent prompt.

## Non-goals

- `/resume` (session picker / log replay) — excluded; substantial hax-side logic
  better exposed via a protocol control later, if ever.
- Mounted-mode slash interception — out of scope now. The pure `classifyLine`
  helper and `SlashController` are built from generic deps so they can be reused
  in the ai-whisper adapter later without change.
- No hax changes. The fork stays minimal; this is pure harness work.

## Architecture

Approach: a **`SlashController`** class (the extension point) that owns command
effects and rendering, plus a **pure `classifyLine`** helper and a command
registry it consults. The pure parser keeps classification testable without
effects; the controller is the unit everything else drives.

New module **`packages/cli/src/repl/slash.ts`** exports the types, the pure
classifier, the built-in commands, and the controller. The REPL
(`standalone.ts`) delegates every submitted line to the controller and acts on
its outcome. The runtime (`standalone-runtime.ts`) constructs the controller with
real capabilities. A small **`packages/cli/src/repl/clipboard.ts`** provides the
platform clipboard function (injectable, so tests never shell out).

### Interfaces

```ts
import type { Session } from "@ai-ezio/harness";
import type { AssistantTurnFinishedEvent, StatusEvent } from "@ai-ezio/protocol";

/** What the REPL should do after the controller handles a line. */
export type SlashOutcome =
	| { action: "handled" } // command ran (or was unknown); do not submit
	| { action: "submit"; text: string } // not a command; submit to the engine
	| { action: "exit" }; // /quit — stop the REPL

/** Capabilities a command may use. Injected so the controller is unit-testable
 * and reusable outside standalone. */
export interface SlashContext {
	write(s: string): void;
	session: Pick<Session, "newConversation" | "status">;
	/** Last assistant turn's content (event-tracked); "" if none yet. */
	lastContent(): string;
	/** Last assistant turn's usage (event-tracked); undefined if none yet. */
	lastUsage(): AssistantTurnFinishedEvent["usage"] | undefined;
	/** Discovered skills, for /skills (the existing `Skill` shape from
	 * packages/cli/src/skills.ts: name, source, description: string | null). */
	skills(): { name: string; source: string; description: string | null }[];
	/** Copy text to the OS clipboard; rejects when no clipboard tool exists. */
	clipboard(text: string): Promise<void>;
}

export interface SlashCommand {
	name: string; // canonical, lowercase, bareword
	aliases?: string[];
	summary: string; // shown in /help
	run(ctx: SlashContext, args: string): Promise<void> | void;
}

/** Pure. Decide whether `line` is a command, an unknown command, or plain text
 * to submit. `known` contains every canonical name AND alias. */
export function classifyLine(
	line: string,
	known: ReadonlySet<string>,
):
	| { kind: "submit" }
	| { kind: "command"; name: string; args: string }
	| { kind: "unknown"; name: string };

export class SlashController {
	constructor(ctx: SlashContext); // registers the built-ins
	register(cmd: SlashCommand): void; // extension seam
	handle(line: string): Promise<SlashOutcome>;
}
```

## Parsing semantics (`classifyLine`)

Applied in order; the first match wins:

1. If `line` does not start with `/` → `submit`.
2. If `line` contains a newline (`\n`) → `submit`. A multiline buffer (or a
   pasted block that begins with `/`) is never a command.
3. Strip the leading `/`; the first whitespace-delimited token is the candidate
   `name`, the remainder (trimmed) is `args`.
4. If `name` is empty (`/` or `/ …`) → `submit`.
5. If `name` does not match `^[a-zA-Z][\w-]*$` (e.g. contains `/`, `.`, etc. —
   `/tmp/foo`, `/etc/hosts`, `/a.b`) → `submit`. This is the path/regex escape
   hatch.
6. Lowercase `name`. If it is in `known` → `{ kind: "command", name, args }`,
   else `{ kind: "unknown", name }`.

Worked examples:

| Input | Result |
|---|---|
| `hello world` | submit |
| `/help` | command `help` |
| `/clear` | command `clear` → resolves to `new` |
| `/status now` | command `status`, args `"now"` |
| `/halp` | unknown `halp` |
| `/tmp/foo.txt` | submit (embedded slash) |
| `/etc/hosts` | submit |
| `/` | submit |
| `foo\n/bar` | submit (multiline) |

## Commands & data flow

State tracking: `standalone-runtime`'s existing `onEvent` updates two locals the
context exposes — `lastContent` from `assistant_turn_finished.content`,
`lastUsage` from `assistant_turn_finished.usage` (M7).

| Command | Effect | Renders | Outcome |
|---|---|---|---|
| `/help` | read the registry | each command `name` + `summary`, then shortcuts (Enter, Alt+Enter, paste, Ctrl-C, Ctrl-D) | handled |
| `/new` (`/clear`) | `await session.newConversation()` | `— new conversation —` | handled |
| `/status` | `await session.status()` | `provider · model · effort` from the `StatusEvent` | handled |
| `/skills` | `ctx.skills()` | `name · source` per skill, or `(no skills found)` | handled |
| `/copy` | `await ctx.clipboard(ctx.lastContent())` | `copied N bytes`, or `no response to copy` when empty | handled |
| `/usage` | read `ctx.lastUsage()` | context / output / cached / limit tokens, or `no usage yet` | handled |
| `/quit` (`/exit`) | none | nothing | exit |

Notes:

- `/new` and `/status` are the only engine-touching commands; both go through
  **existing** protocol controls (`newConversation`, `status`) and are
  **awaited**, so the REPL never races ahead. Because those controls emit `idle`
  / `status` respectively, neither hangs.
- `/copy` uses the **locally tracked** last response — no `copy_last_response`
  round-trip — and the injected `clipboard` fn (`pbcopy` on darwin; `wl-copy`
  then `xclip` on linux), chosen by platform, best-effort.
- `/usage` is pure-local formatting of the last usage already received; no engine
  call.
- Rendering is styled text via `ctx.write` (dim/cyan to match the look ezio's
  surface mimics). Each command renders itself, so a future `register()`'d
  command follows the same contract.

### REPL integration

`runStandaloneRepl` gains a `slash: Pick<SlashController, "handle">` dep. On a
completed line:

```ts
if (r.submit !== undefined) {
	if (r.submit.trim() === "") continue;
	const outcome = await deps.slash.handle(r.submit);
	if (outcome.action === "exit") break;
	if (outcome.action === "submit") {
		deps.session.submit(outcome.text);
		await deps.session.waitForEvent("idle");
	}
	// "handled" → fall through and prompt again (no engine round-trip)
}
```

This is the fix: a command yields `handled`, so we never submit-and-wait on a
line hax would swallow.

## Error handling

- **Unknown command** → controller writes
  `unknown command: /<name>. type /help for the list.` and returns `handled`
  (never submitted, never hung).
- **A command's `run()` throws** → controller catches, writes
  `/<name> failed: <message>`, returns `handled`. A command failure must never
  crash the REPL.
- **Engine-touching command while the engine is gone** (`/new`, `/status`):
  the awaited control rejects (`EngineExitedError`); caught by the same
  `run()`-throw guard and surfaced as a failure line. The events stream ending
  drives the normal eof teardown on the next loop turn.
- **Clipboard unavailable** (`/copy`): `clipboard()` rejects; `/copy` catches and
  writes `clipboard unavailable: <message>`. Best-effort, surfaced only on
  failure (consistent with the MCP-host health convention).

## Testing

Pure `classifyLine` (no I/O):
- submit (plain text), command (`/help`), alias (`/clear` → known), args
  (`/status now`), unknown (`/halp`), path-like (`/tmp/foo`, `/etc/hosts` →
  submit), bare `/` → submit, multiline → submit, case-insensitivity
  (`/HELP` → command).

`SlashController.handle` with a fake `SlashContext` (capturing `write`, fake
session, injected clipboard):
- each command's rendered output + outcome;
- `/copy` success and failure (rejecting clipboard) and empty-content path;
- `/usage` with and without `lastUsage`;
- `/new` awaits `newConversation`; `/status` renders a fake `StatusEvent`;
- unknown → error line + `handled`; a throwing `run()` → caught, `handled`;
- `register()` — a custom command becomes dispatchable and shows in `/help`.

REPL loop (`standalone.test.ts`, fakes): a `handled` outcome does **not** call
`waitForEvent` (regression guard for the hang); `submit` does; `exit` stops.

Clipboard util: inject the spawn function so tests assert the platform argv
without shelling out.

## Files & module boundaries

- `packages/cli/src/repl/slash.ts` — `classifyLine`, types, built-in commands,
  `SlashController`.
- `packages/cli/src/repl/slash.test.ts` — unit tests above.
- `packages/cli/src/repl/clipboard.ts` — platform clipboard fn (injectable).
- `packages/cli/src/repl/standalone.ts` — add the `slash` dep + outcome branch.
- `packages/cli/src/repl/standalone-runtime.ts` — build `SlashContext`
  (writer, session, `lastContent`/`lastUsage` tracking in `onEvent`,
  `discoverSkills`, clipboard, exit), construct the controller, pass it in.

This exceeds three files, so the implementation plan should stage it:
1. Pure `classifyLine` + types + `SlashController` + built-ins + their tests.
2. Clipboard util + test.
3. Wire into `standalone.ts` / `standalone-runtime.ts` (state tracking + loop
   branch) + REPL test.

## Edge cases

- A pasted multiline block beginning with `/` → submitted to the model (rule 2),
  consistent with the bracketed-paste behavior just shipped.
- `/copy` before any turn → `no response to copy`.
- `/usage` before any turn → `no usage yet`.
- `/status` / `/new` race: awaited, so a second line can't be submitted mid-command.
- An alias collision on `register()` (a custom command reusing a built-in name or
  alias): last registration wins; document it, and `/help` reflects the active
  set.
