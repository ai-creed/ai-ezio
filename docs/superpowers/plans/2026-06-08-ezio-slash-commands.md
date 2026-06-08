# ezio-owned slash commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ezio's standalone REPL its own `/`-command system (help, new/clear, status, skills, copy, usage, quit/exit) so slash commands work locally and never hang by reaching the headless hax engine.

**Architecture:** A new `packages/cli/src/repl/slash.ts` exports a pure `classifyLine` parser, the command types, the built-in commands, and a `SlashController` (the extension point). The REPL loop (`standalone.ts`) delegates every completed line to the controller and acts on a three-way outcome (`handled` / `submit` / `exit`); the runtime (`standalone-runtime.ts`) builds the controller with real capabilities and tracks the last turn's content/usage from the event stream. A small injectable `clipboard.ts` provides the platform copy function. No hax changes.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspace, vitest. Tabs, double quotes, semicolons, trailing commas (project baseline). Engine/REPL types come from `@ai-ezio/harness` and `@ai-ezio/protocol`.

**Reference spec:** `docs/superpowers/specs/2026-06-08-ezio-slash-commands-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/cli/src/repl/slash.ts` | Types (`SlashOutcome`, `SlashContext`, `SlashCommand`), pure `classifyLine`, built-in commands, `SlashController` | Create |
| `packages/cli/src/repl/slash.test.ts` | Unit tests for `classifyLine` + `SlashController.handle` | Create |
| `packages/cli/src/repl/clipboard.ts` | Platform clipboard fn (`pbcopy` / `wl-copy` → `xclip`), spawn injected | Create |
| `packages/cli/src/repl/clipboard.test.ts` | Unit tests for the clipboard fn (fake spawn) | Create |
| `packages/cli/src/repl/standalone.ts` | Add the `slash` dep + outcome branch to the REPL loop | Modify |
| `packages/cli/src/repl/standalone.test.ts` | Update existing tests for the new dep; add the no-wait regression guard | Modify |
| `packages/cli/src/repl/standalone-runtime.ts` | Build `SlashContext` (writer, session, `lastContent`/`lastUsage` tracking, skills, clipboard), construct `SlashController`, pass it in | Modify |

Staged so each task is self-contained and individually testable:

1. **Task 1** — pure `classifyLine` + types (no I/O).
2. **Task 2** — built-in commands + `SlashController` on top of Task 1.
3. **Task 3** — clipboard util (independent of 1–2).
4. **Task 4** — wire the controller into the REPL loop (`standalone.ts`) + the hang regression guard.
5. **Task 5** — assemble the real `SlashContext` + controller in the runtime.

Tasks 1–3 are pure/unit-tested; Tasks 4–5 are the wiring. Tasks 1, 2, and 3 are independent and could be done in any order; 4 depends on 1–2; 5 depends on 1–3 and 4.

---

## Task 1: Pure `classifyLine` + command types

**Files:**
- Create: `packages/cli/src/repl/slash.ts`
- Create (start): `packages/cli/src/repl/slash.test.ts`

- [ ] **Step 1: Write the failing test for `classifyLine`**

Create `packages/cli/src/repl/slash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyLine } from "./slash.js";

const KNOWN = new Set(["help", "new", "clear", "status", "skills", "copy", "usage", "quit", "exit"]);

describe("classifyLine", () => {
	it("plain text → submit", () => {
		expect(classifyLine("hello world", KNOWN)).toEqual({ kind: "submit" });
	});
	it("known command → command", () => {
		expect(classifyLine("/help", KNOWN)).toEqual({ kind: "command", name: "help", args: "" });
	});
	it("alias is known → command with the alias name", () => {
		expect(classifyLine("/clear", KNOWN)).toEqual({ kind: "command", name: "clear", args: "" });
	});
	it("captures args after the first whitespace, trimmed", () => {
		expect(classifyLine("/status   now ", KNOWN)).toEqual({
			kind: "command",
			name: "status",
			args: "now",
		});
	});
	it("case-insensitive name", () => {
		expect(classifyLine("/HELP", KNOWN)).toEqual({ kind: "command", name: "help", args: "" });
	});
	it("unknown command → unknown", () => {
		expect(classifyLine("/halp", KNOWN)).toEqual({ kind: "unknown", name: "halp" });
	});
	it("embedded slash (path) → submit", () => {
		expect(classifyLine("/tmp/foo.txt", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/etc/hosts", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/a.b", KNOWN)).toEqual({ kind: "submit" });
	});
	it("bare slash → submit", () => {
		expect(classifyLine("/", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/ status", KNOWN)).toEqual({ kind: "submit" });
	});
	it("multiline (contains newline) → submit", () => {
		expect(classifyLine("foo\n/bar", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/help\nmore", KNOWN)).toEqual({ kind: "submit" });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ai-ezio test src/repl/slash.test.ts`
Expected: FAIL — `Failed to resolve import "./slash.js"` (module/function does not exist yet).

- [ ] **Step 3: Write the types + `classifyLine`**

Create `packages/cli/src/repl/slash.ts` with the types and the pure parser (commands/controller come in Task 2):

```ts
/**
 * ezio-owned slash commands for the standalone REPL. A submitted `/`-command is
 * handled locally by ezio (rendered through ezio's own writer) and never reaches
 * the headless hax engine — hax's TUI slash commands write to a dead fd and the
 * mounted agent loop swallows them without emitting `idle`, which hangs the REPL.
 *
 * `classifyLine` is pure (testable without effects); `SlashController` owns the
 * registry + dispatch and is the extension point for future harness commands.
 */
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
	/** Discovered skills, for /skills (the `Skill` shape from skills.ts). */
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

export type LineClass =
	| { kind: "submit" }
	| { kind: "command"; name: string; args: string }
	| { kind: "unknown"; name: string };

const NAME_RE = /^[a-zA-Z][\w-]*$/;

/** Pure. Decide whether `line` is a command, an unknown command, or plain text
 * to submit. `known` contains every canonical name AND alias. Rules apply in
 * order; first match wins (see the spec's "Parsing semantics"). */
export function classifyLine(line: string, known: ReadonlySet<string>): LineClass {
	if (!line.startsWith("/")) return { kind: "submit" };
	if (line.includes("\n")) return { kind: "submit" };
	const body = line.slice(1);
	const ws = body.search(/\s/);
	const rawName = ws === -1 ? body : body.slice(0, ws);
	const args = ws === -1 ? "" : body.slice(ws).trim();
	if (rawName === "") return { kind: "submit" }; // "/" or "/ …"
	if (!NAME_RE.test(rawName)) return { kind: "submit" }; // "/tmp/foo", "/a.b" — path escape hatch
	const name = rawName.toLowerCase();
	return known.has(name) ? { kind: "command", name, args } : { kind: "unknown", name };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter ai-ezio test src/repl/slash.test.ts`
Expected: PASS (the `classifyLine` block — 9 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/repl/slash.ts packages/cli/src/repl/slash.test.ts
git commit -m "feat(cli): pure classifyLine slash parser + command types"
```

---

## Task 2: Built-in commands + `SlashController`

**Files:**
- Modify: `packages/cli/src/repl/slash.ts`
- Modify: `packages/cli/src/repl/slash.test.ts`

- [ ] **Step 1: Write the failing tests for `SlashController.handle`**

Append to `packages/cli/src/repl/slash.test.ts`:

```ts
import { SlashController, type SlashContext } from "./slash.js";
import type { StatusEvent } from "@ai-ezio/protocol";

/** Build a SlashContext that captures writes and lets each test override pieces. */
function fakeCtx(over: Partial<SlashContext> = {}): { ctx: SlashContext; out: () => string } {
	const chunks: string[] = [];
	const ctx: SlashContext = {
		write: (s) => chunks.push(s),
		session: {
			newConversation: async () => {},
			status: async () =>
				({
					type: "status",
					model: "claude-x",
					provider: "anthropic",
					protocol: "1",
					sessionId: "s1",
					state: "idle",
					effort: "high",
				}) as StatusEvent,
		},
		lastContent: () => "",
		lastUsage: () => undefined,
		skills: () => [],
		clipboard: async () => {},
		...over,
	};
	return { ctx, out: () => chunks.join("") };
}

describe("SlashController.handle", () => {
	it("plain text → submit outcome with the original line", async () => {
		const { ctx } = fakeCtx();
		const c = new SlashController(ctx);
		expect(await c.handle("hello world")).toEqual({ action: "submit", text: "hello world" });
	});

	it("/quit (and /exit) → exit outcome", async () => {
		const { ctx } = fakeCtx();
		const c = new SlashController(ctx);
		expect(await c.handle("/quit")).toEqual({ action: "exit" });
		expect(await c.handle("/exit")).toEqual({ action: "exit" });
	});

	it("/help lists every command and the shortcuts", async () => {
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		expect(await c.handle("/help")).toEqual({ action: "handled" });
		const text = out();
		for (const name of ["help", "new", "status", "skills", "copy", "usage", "quit"]) {
			expect(text).toContain(`/${name}`);
		}
		expect(text).toContain("Alt+Enter");
		expect(text).toContain("Ctrl-D");
	});

	it("/new awaits newConversation and confirms", async () => {
		let called = 0;
		const { ctx, out } = fakeCtx({ session: { newConversation: async () => void called++, status: async () => ({}) as StatusEvent } });
		const c = new SlashController(ctx);
		expect(await c.handle("/new")).toEqual({ action: "handled" });
		expect(called).toBe(1);
		expect(out()).toContain("new conversation");
	});

	it("/clear is an alias for /new", async () => {
		let called = 0;
		const { ctx } = fakeCtx({ session: { newConversation: async () => void called++, status: async () => ({}) as StatusEvent } });
		const c = new SlashController(ctx);
		expect(await c.handle("/clear")).toEqual({ action: "handled" });
		expect(called).toBe(1);
	});

	it("/status renders provider · model · effort", async () => {
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		await c.handle("/status");
		expect(out()).toContain("anthropic");
		expect(out()).toContain("claude-x");
		expect(out()).toContain("high");
	});

	it("/skills lists name · source, or a placeholder when empty", async () => {
		const empty = fakeCtx();
		await new SlashController(empty.ctx).handle("/skills");
		expect(empty.out()).toContain("(no skills found)");

		const some = fakeCtx({
			skills: () => [{ name: "debugging", source: "project", description: "d" }],
		});
		await new SlashController(some.ctx).handle("/skills");
		expect(some.out()).toContain("debugging");
		expect(some.out()).toContain("project");
	});

	it("/copy with content copies and reports byte count", async () => {
		let copied = "";
		const { ctx, out } = fakeCtx({
			lastContent: () => "héllo",
			clipboard: async (t) => void (copied = t),
		});
		await new SlashController(ctx).handle("/copy");
		expect(copied).toBe("héllo");
		expect(out()).toContain(`copied ${Buffer.byteLength("héllo", "utf8")} bytes`);
	});

	it("/copy with no content → no response to copy", async () => {
		const { ctx, out } = fakeCtx({ lastContent: () => "" });
		await new SlashController(ctx).handle("/copy");
		expect(out()).toContain("no response to copy");
	});

	it("/copy surfaces a rejecting clipboard as unavailable", async () => {
		const { ctx, out } = fakeCtx({
			lastContent: () => "x",
			clipboard: async () => {
				throw new Error("pbcopy not found");
			},
		});
		await new SlashController(ctx).handle("/copy");
		expect(out()).toContain("clipboard unavailable");
		expect(out()).toContain("pbcopy not found");
	});

	it("/usage renders tracked usage, or a placeholder when absent", async () => {
		const none = fakeCtx({ lastUsage: () => undefined });
		await new SlashController(none.ctx).handle("/usage");
		expect(none.out()).toContain("no usage yet");

		const some = fakeCtx({
			lastUsage: () => ({ contextTokens: 100, outputTokens: 20, cachedTokens: 5, contextLimit: 200000 }),
		});
		await new SlashController(some.ctx).handle("/usage");
		const text = some.out();
		expect(text).toContain("100");
		expect(text).toContain("20");
		expect(text).toContain("200000");
	});

	it("unknown command → error line + handled (never submits)", async () => {
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		expect(await c.handle("/halp")).toEqual({ action: "handled" });
		expect(out()).toContain("unknown command: /halp");
		expect(out()).toContain("/help");
	});

	it("a throwing command is caught and reported, returns handled", async () => {
		const { ctx, out } = fakeCtx({
			session: {
				newConversation: async () => {
					throw new Error("engine exited");
				},
				status: async () => ({}) as StatusEvent,
			},
		});
		const c = new SlashController(ctx);
		expect(await c.handle("/new")).toEqual({ action: "handled" });
		expect(out()).toContain("/new failed");
		expect(out()).toContain("engine exited");
	});

	it("register() adds a dispatchable command that shows in /help", async () => {
		let ran = "";
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		c.register({
			name: "echo",
			summary: "echo the args",
			run: (cx, args) => void (ran = args),
		});
		expect(await c.handle("/echo hi there")).toEqual({ action: "handled" });
		expect(ran).toBe("hi there");
		await c.handle("/help");
		expect(out()).toContain("/echo");
	});

	it("register() overriding a built-in NAME fully displaces it (no stale /help, alias dropped)", async () => {
		let ran = false;
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		c.register({ name: "new", summary: "custom new", run: () => void (ran = true) });
		// /new now dispatches the override, not the built-in newConversation path.
		expect(await c.handle("/new")).toEqual({ action: "handled" });
		expect(ran).toBe(true);
		// The displaced built-in's "clear" alias is gone — last registration wins.
		expect(await c.handle("/clear")).toEqual({ action: "handled" });
		expect(out()).toContain("unknown command: /clear");
		// /help shows the override exactly once, with no stale built-in "new".
		const before = out();
		await c.handle("/help");
		const help = out().slice(before.length);
		expect(help).toContain("custom new");
		expect(help.match(/\/new\b/g)?.length).toBe(1);
	});

	it("register() overriding a built-in ALIAS wins the key but leaves the built-in's name intact", async () => {
		let ran = false;
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		c.register({ name: "fresh", aliases: ["clear"], summary: "fresh start", run: () => void (ran = true) });
		// "clear" was the built-in /new alias; last registration wins → the override.
		expect(await c.handle("/clear")).toEqual({ action: "handled" });
		expect(ran).toBe(true);
		// The built-in /new still works (its own name key was untouched).
		expect(await c.handle("/new")).toEqual({ action: "handled" });
		// /help lists both canonical names once each — no stale duplicate.
		await c.handle("/help");
		const help = out();
		expect(help).toContain("/fresh");
		expect(help.match(/\/new\b/g)?.length).toBe(1);
		expect(help.match(/\/fresh\b/g)?.length).toBe(1);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter ai-ezio test src/repl/slash.test.ts`
Expected: FAIL — `SlashController is not exported` / `is not a constructor`.

- [ ] **Step 3: Implement the built-in commands + `SlashController`**

Append to `packages/cli/src/repl/slash.ts`:

```ts
/** Render the /help listing: each command, then the keyboard shortcuts. */
function renderHelp(ctx: SlashContext, cmds: { name: string; summary: string }[]): void {
	for (const c of cmds) ctx.write(`  /${c.name}  ${c.summary}\n`);
	ctx.write(
		"\nshortcuts: Enter submit · Alt+Enter newline · paste multiline · Ctrl-C interrupt · Ctrl-D exit\n",
	);
}

/** Format the tracked per-turn usage, or null when nothing is reportable. */
function formatUsage(u: AssistantTurnFinishedEvent["usage"]): string | null {
	if (!u) return null;
	const parts: string[] = [];
	if (u.contextTokens !== undefined) parts.push(`context ${u.contextTokens}`);
	if (u.outputTokens !== undefined) parts.push(`output ${u.outputTokens}`);
	if (u.cachedTokens !== undefined) parts.push(`cached ${u.cachedTokens}`);
	if (u.contextLimit !== undefined) parts.push(`limit ${u.contextLimit}`);
	return parts.length ? parts.join(" · ") : null;
}

/** The built-in command set (full parity minus /resume). `listCommands` is a
 * live view of the registry so /help reflects register()'d additions. */
function builtinCommands(listCommands: () => { name: string; summary: string }[]): SlashCommand[] {
	return [
		{
			name: "help",
			summary: "list commands and keyboard shortcuts",
			run: (ctx) => renderHelp(ctx, listCommands()),
		},
		{
			name: "new",
			aliases: ["clear"],
			summary: "start a new conversation",
			run: async (ctx) => {
				await ctx.session.newConversation();
				ctx.write("— new conversation —\n");
			},
		},
		{
			name: "status",
			summary: "show provider, model, and effort",
			run: async (ctx) => {
				const s = await ctx.session.status();
				const effort = s.effort ? ` · ${s.effort}` : "";
				ctx.write(`${s.provider} · ${s.model}${effort}\n`);
			},
		},
		{
			name: "skills",
			summary: "list discovered skills",
			run: (ctx) => {
				const skills = ctx.skills();
				if (skills.length === 0) {
					ctx.write("(no skills found)\n");
					return;
				}
				for (const s of skills) ctx.write(`  ${s.name} · ${s.source}\n`);
			},
		},
		{
			name: "copy",
			summary: "copy the last response to the clipboard",
			run: async (ctx) => {
				const text = ctx.lastContent();
				if (text === "") {
					ctx.write("no response to copy\n");
					return;
				}
				try {
					await ctx.clipboard(text);
					ctx.write(`copied ${Buffer.byteLength(text, "utf8")} bytes\n`);
				} catch (e) {
					ctx.write(`clipboard unavailable: ${(e as Error).message}\n`);
				}
			},
		},
		{
			name: "usage",
			summary: "show the last turn's token usage",
			run: (ctx) => {
				const formatted = formatUsage(ctx.lastUsage());
				ctx.write(formatted ? `${formatted}\n` : "no usage yet\n");
			},
		},
		{
			name: "quit",
			aliases: ["exit"],
			summary: "exit ezio",
			run: () => {}, // the controller maps /quit to the exit outcome before run()
		},
	];
}

/** Owns the command registry + dispatch. The unit the REPL drives, and the
 * extension point: call register() to add harness-purpose commands later. */
export class SlashController {
	private readonly ctx: SlashContext;
	/** name OR alias → command (so classifyLine's `known` set is keys()). */
	private readonly byKey = new Map<string, SlashCommand>();

	constructor(ctx: SlashContext) {
		this.ctx = ctx;
		for (const cmd of builtinCommands(() => this.summaries())) this.register(cmd);
	}

	/** Register (or override) a command and its aliases. Last registration wins
	 * per key: any command that already owns this command's NAME is fully evicted
	 * (all of its keys removed) so an override replaces it cleanly; an alias key
	 * collision is resolved key-by-key (the alias now points at the new command,
	 * but the prior owner keeps its other keys). */
	register(cmd: SlashCommand): void {
		const displaced = this.byKey.get(cmd.name);
		if (displaced) {
			for (const [k, v] of this.byKey) if (v === displaced) this.byKey.delete(k);
		}
		this.byKey.set(cmd.name, cmd);
		for (const a of cmd.aliases ?? []) this.byKey.set(a, cmd);
	}

	/** Deduped canonical command list for /help. A command is listed only if it
	 * still OWNS its own name key — this filters out any command reachable only
	 * through a stolen alias key (e.g. another command claimed its name), so
	 * /help never shows a stale entry. */
	private summaries(): { name: string; summary: string }[] {
		const seen = new Set<SlashCommand>();
		const out: { name: string; summary: string }[] = [];
		for (const cmd of this.byKey.values()) {
			if (seen.has(cmd)) continue;
			seen.add(cmd);
			if (this.byKey.get(cmd.name) !== cmd) continue; // reachable only via a stolen alias
			out.push({ name: cmd.name, summary: cmd.summary });
		}
		return out;
	}

	async handle(line: string): Promise<SlashOutcome> {
		const c = classifyLine(line, new Set(this.byKey.keys()));
		if (c.kind === "submit") return { action: "submit", text: line };
		if (c.kind === "unknown") {
			this.ctx.write(`unknown command: /${c.name}. type /help for the list.\n`);
			return { action: "handled" };
		}
		const cmd = this.byKey.get(c.name);
		if (!cmd) return { action: "handled" }; // unreachable: known set came from byKey
		if (cmd.name === "quit") return { action: "exit" };
		try {
			await cmd.run(this.ctx, c.args);
		} catch (e) {
			this.ctx.write(`/${c.name} failed: ${(e as Error).message}\n`);
		}
		return { action: "handled" };
	}
}
```

Note: the `import type { StatusEvent }` already added at the top of `slash.ts` in Task 1 is used by `SlashContext.session`; keep it. The new test file's separate `import type { StatusEvent }` is independent.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter ai-ezio test src/repl/slash.test.ts`
Expected: PASS (all `classifyLine` + `SlashController.handle` tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/repl/slash.ts packages/cli/src/repl/slash.test.ts
git commit -m "feat(cli): SlashController + built-in slash commands"
```

---

## Task 3: Platform clipboard utility

**Files:**
- Create: `packages/cli/src/repl/clipboard.ts`
- Create: `packages/cli/src/repl/clipboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/repl/clipboard.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { makeClipboard } from "./clipboard.js";

/** A fake child process whose `close` we drive, capturing what was written. */
function fakeChild(exitCode: number) {
	const child = new EventEmitter() as EventEmitter & {
		stdin: { end: (s: string) => void };
		written: string;
	};
	child.written = "";
	child.stdin = { end: (s: string) => void (child.written = s) };
	// Emit close on the next microtask so the listener is attached first.
	queueMicrotask(() => child.emit("close", exitCode));
	return child;
}

describe("makeClipboard", () => {
	it("darwin uses pbcopy and writes the text to stdin", async () => {
		const argvs: string[][] = [];
		let captured = "";
		const spawnFn = ((cmd: string, args: string[]) => {
			argvs.push([cmd, ...args]);
			const c = fakeChild(0);
			const origEnd = c.stdin.end;
			c.stdin.end = (s: string) => {
				captured = s;
				origEnd(s);
			};
			return c;
		}) as never;
		const copy = makeClipboard("darwin", spawnFn);
		await copy("hello");
		expect(argvs).toEqual([["pbcopy"]]);
		expect(captured).toBe("hello");
	});

	it("linux tries wl-copy first, falls back to xclip on spawn error", async () => {
		const tried: string[] = [];
		const spawnFn = ((cmd: string) => {
			tried.push(cmd);
			if (cmd === "wl-copy") {
				const c = new EventEmitter() as never as ReturnType<typeof fakeChild>;
				(c as unknown as { stdin: { end: () => void } }).stdin = { end: () => {} };
				queueMicrotask(() => (c as unknown as EventEmitter).emit("error", new Error("ENOENT")));
				return c;
			}
			return fakeChild(0);
		}) as never;
		const copy = makeClipboard("linux", spawnFn);
		await copy("x");
		expect(tried).toEqual(["wl-copy", "xclip"]);
	});

	it("rejects when every candidate fails", async () => {
		const spawnFn = (() => {
			const c = new EventEmitter() as never as { stdin: { end: () => void } } & EventEmitter;
			(c as unknown as { stdin: { end: () => void } }).stdin = { end: () => {} };
			queueMicrotask(() => (c as unknown as EventEmitter).emit("error", new Error("ENOENT")));
			return c;
		}) as never;
		const copy = makeClipboard("linux", spawnFn);
		await expect(copy("x")).rejects.toThrow();
	});

	it("rejects when the tool exits non-zero", async () => {
		const spawnFn = (() => fakeChild(1)) as never;
		const copy = makeClipboard("darwin", spawnFn);
		await expect(copy("x")).rejects.toThrow(/exited 1/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ai-ezio test src/repl/clipboard.test.ts`
Expected: FAIL — `Failed to resolve import "./clipboard.js"`.

- [ ] **Step 3: Implement the clipboard utility**

Create `packages/cli/src/repl/clipboard.ts`:

```ts
/**
 * Platform clipboard write for /copy. Best-effort: on darwin uses `pbcopy`; on
 * linux tries `wl-copy` (Wayland) then `xclip` (X11). Rejects when no tool is
 * available or a tool errors, so /copy can surface "clipboard unavailable". The
 * spawn function is injected so tests assert the argv without shelling out.
 */
import { spawn } from "node:child_process";

export type SpawnFn = typeof spawn;

/** Run one clipboard tool, piping `text` to its stdin. Resolves on exit 0. */
function tryCopy(argv: string[], text: string, spawnFn: SpawnFn): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawnFn(argv[0]!, argv.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", reject); // ENOENT when the tool isn't installed
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}`)),
		);
		child.stdin?.end(text);
	});
}

/** Build a clipboard fn for `platform`. Tries candidates in order, rejecting
 * with the last error only when all fail. */
export function makeClipboard(platform: NodeJS.Platform, spawnFn: SpawnFn = spawn) {
	const candidates: string[][] =
		platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
	return async (text: string): Promise<void> => {
		let lastErr: Error = new Error("no clipboard tool available");
		for (const argv of candidates) {
			try {
				await tryCopy(argv, text, spawnFn);
				return;
			} catch (e) {
				lastErr = e as Error;
			}
		}
		throw lastErr;
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter ai-ezio test src/repl/clipboard.test.ts`
Expected: PASS (4 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/repl/clipboard.ts packages/cli/src/repl/clipboard.test.ts
git commit -m "feat(cli): injectable platform clipboard helper"
```

---

## Task 4: Wire the controller into the REPL loop

**Files:**
- Modify: `packages/cli/src/repl/standalone.ts`
- Modify: `packages/cli/src/repl/standalone.test.ts`

- [ ] **Step 1: Update existing tests + add the no-wait regression guard**

Replace the entire contents of `packages/cli/src/repl/standalone.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { runStandaloneRepl } from "./standalone.js";
import type { SlashOutcome } from "./slash.js";

/** A fake slash controller: each entry in `outcomes` is matched by submitted
 * line; default is to submit the line verbatim. */
function fakeSlash(map: (line: string) => SlashOutcome = (line) => ({ action: "submit", text: line })) {
	const seen: string[] = [];
	return {
		seen,
		handle: async (line: string) => {
			seen.push(line);
			return map(line);
		},
	};
}

describe("runStandaloneRepl", () => {
	it("submits a typed line, waits for idle, and exits on Ctrl-D", async () => {
		const submitted: string[] = [];
		const waited: string[] = [];
		async function* keys() {
			for (const k of ["h", "i", "\r", "\x04"]) yield k;
		}
		const session = {
			submit: (t: string) => submitted.push(t),
			interrupt: () => {},
			waitForEvent: async (e: string) => {
				waited.push(e);
				return { type: "idle" } as never;
			},
			close: () => {},
		};
		let stopped = false;
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => void (stopped = true) } as never,
			write: () => {},
			slash: fakeSlash(),
		});
		expect(submitted).toEqual(["hi"]);
		expect(waited).toEqual(["idle"]);
		expect(stopped).toBe(true);
	});

	it("Ctrl-C interrupts without submitting", async () => {
		const calls: string[] = [];
		async function* keys() {
			for (const k of ["x", "\x03", "\x04"]) yield k;
		}
		const session = {
			submit: () => calls.push("submit"),
			interrupt: () => calls.push("interrupt"),
			waitForEvent: async () => ({ type: "idle" }) as never,
			close: () => {},
		};
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(),
		});
		expect(calls).toEqual(["interrupt"]);
	});

	it("a 'handled' outcome does NOT submit or wait (slash-command hang guard)", async () => {
		const calls: string[] = [];
		async function* keys() {
			// type "/help", Enter, then Ctrl-D
			for (const k of ["/", "h", "e", "l", "p", "\r", "\x04"]) yield k;
		}
		const session = {
			submit: () => calls.push("submit"),
			interrupt: () => {},
			waitForEvent: async () => {
				calls.push("wait");
				return { type: "idle" } as never;
			},
			close: () => {},
		};
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(() => ({ action: "handled" })),
		});
		expect(calls).toEqual([]); // never submitted, never waited
	});

	it("an 'exit' outcome stops the loop immediately", async () => {
		const calls: string[] = [];
		async function* keys() {
			for (const k of ["/", "q", "\r", "x", "\x04"]) yield k; // x/Ctrl-D after exit must not run
		}
		const session = {
			submit: () => calls.push("submit"),
			interrupt: () => {},
			waitForEvent: async () => ({ type: "idle" }) as never,
			close: () => calls.push("close"),
		};
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(() => ({ action: "exit" })),
		});
		expect(calls).toContain("close");
		expect(calls).not.toContain("submit");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter ai-ezio test src/repl/standalone.test.ts`
Expected: FAIL — type error / runtime error: `runStandaloneRepl` does not accept/await a `slash` dep yet (the new tests reference `deps.slash`).

- [ ] **Step 3: Add the `slash` dep + outcome branch to the loop**

In `packages/cli/src/repl/standalone.ts`, add the import and extend the deps interface:

```ts
import type { SlashController } from "./slash.js";
```

Extend `StandaloneReplDeps`:

```ts
export interface StandaloneReplDeps {
	keys: AsyncIterable<string>;
	session: Pick<Session, "submit" | "interrupt" | "waitForEvent" | "close">;
	host: Pick<McpHost, "handleEvent" | "stop">;
	write: (s: string) => void;
	/** Local slash-command dispatch; a submitted line is routed here first. */
	slash: Pick<SlashController, "handle">;
}
```

Replace the submit branch (the current `if (r.submit !== undefined) { … await deps.session.waitForEvent("idle"); }`) with:

```ts
		if (r.submit !== undefined) {
			if (r.submit.trim() === "") continue;
			// Route every completed line through the local slash controller first.
			// A handled command never reaches hax (which would hang the REPL); only
			// a "submit" outcome is forwarded to the engine.
			const outcome = await deps.slash.handle(r.submit);
			if (outcome.action === "exit") break;
			if (outcome.action === "submit") {
				deps.session.submit(outcome.text);
				// Wait for the turn to settle before reading the next line. The surface
				// renders streamed events live via Session.onEvent; idle = prompt again.
				await deps.session.waitForEvent("idle");
			}
			// "handled" → fall through and prompt again (no engine round-trip).
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter ai-ezio test src/repl/standalone.test.ts`
Expected: PASS (4 tests green, including the hang guard).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/repl/standalone.ts packages/cli/src/repl/standalone.test.ts
git commit -m "feat(cli): route REPL lines through the slash controller"
```

---

## Task 5: Assemble the real `SlashContext` in the runtime

**Files:**
- Modify: `packages/cli/src/repl/standalone-runtime.ts`

There is no new unit test here — `runStandalone` is the assembly seam (it touches `process.stdout`, real `spawn`, real fs). It is validated by the full build + the Task 1–4 unit suites + a manual smoke. The wiring below uses only already-tested units.

- [ ] **Step 1: Add the imports**

In `packages/cli/src/repl/standalone-runtime.ts`, add:

```ts
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { discoverSkills, nodeSkillFs, type SkillEnv } from "../skills.js";
import { SlashController, type SlashContext } from "./slash.js";
import { makeClipboard } from "./clipboard.js";
```

(`Session`, `loadMcpHost`, `ProtocolEvent`, `createMountedRenderer`, `runStandaloneRepl` are already imported.)

- [ ] **Step 2: Track the last turn and build the controller in `runStandalone`**

In `runStandalone`, replace the current session construction:

```ts
	const session = new Session({
		onEvent: (e: ProtocolEvent) => {
			renderer.handle(e);
			void host.handleEvent(e);
		},
	});
```

with a version that also tracks the last assistant turn for `/copy` and `/usage`:

```ts
	let lastContent = "";
	let lastUsage: import("@ai-ezio/protocol").AssistantTurnFinishedEvent["usage"];
	const session = new Session({
		onEvent: (e: ProtocolEvent) => {
			renderer.handle(e);
			if (e.type === "assistant_turn_finished") {
				lastContent = e.content;
				lastUsage = e.usage;
			}
			void host.handleEvent(e);
		},
	});
```

(Alternatively, add `AssistantTurnFinishedEvent` to the existing `import type { ProtocolEvent } from "@ai-ezio/protocol";` line and type `lastUsage` as `AssistantTurnFinishedEvent["usage"]` — either is fine; keep one style.)

- [ ] **Step 3: Construct the `SlashContext` + controller after `host.start`**

After the `await host.start(session);` line and before the `const stdin = process.stdin;` line, insert:

```ts
	// Build the local slash controller with real capabilities. Skills are
	// rediscovered per /skills call (cheap; reflects on-disk changes).
	const skillEnv: SkillEnv = {
		cwd: process.cwd(),
		home: homedir(),
		xdgConfigHome: process.env.XDG_CONFIG_HOME,
	};
	const skillFs = nodeSkillFs();
	const slashCtx: SlashContext = {
		write: (s) => void process.stdout.write(s),
		session,
		lastContent: () => lastContent,
		lastUsage: () => lastUsage,
		skills: () =>
			discoverSkills(skillEnv, skillFs).map((s) => ({
				name: s.name,
				source: s.source,
				description: s.description,
			})),
		clipboard: makeClipboard(process.platform, spawn),
	};
	const slash = new SlashController(slashCtx);
```

- [ ] **Step 4: Pass the controller into the REPL**

Update the `runStandaloneRepl({ … })` call to include `slash`:

```ts
		await runStandaloneRepl({
			keys: readKeys(stdin),
			session,
			host,
			write: (s) => void process.stdout.write(s),
			slash,
		});
```

- [ ] **Step 5: Verify the package builds and the full CLI suite is green**

Run: `pnpm --filter ai-ezio build && pnpm --filter ai-ezio test`
Expected: build succeeds (no TS errors); all CLI tests pass (slash, clipboard, standalone, input-reader, oneshot).

- [ ] **Step 6: Run the repo gate (build + lint + format check + test)**

Run: `pnpm -r build && pnpm lint && pnpm -r test`
Expected: all green. If Prettier flags the new files, run `pnpm format` and re-stage.

- [ ] **Step 7: Manual smoke (optional but recommended)**

Launch the standalone REPL and verify each command renders locally and none hang:

```
/help        → lists commands + shortcuts
/skills      → lists discovered skills (or "(no skills found)")
/status      → provider · model · effort
say hi       → normal turn; then /copy → "copied N bytes"; /usage → token line
/halp        → "unknown command: /halp. type /help for the list."
/new         → "— new conversation —"
/quit        → exits cleanly
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/repl/standalone-runtime.ts
git commit -m "feat(cli): wire slash controller into the standalone runtime"
```

---

## Edge cases (verified by the tasks above)

- **Pasted block beginning with `/`** → contains a newline → `classifyLine` returns `submit` (Task 1 multiline test); sent to the model, consistent with bracketed paste.
- **`/copy` before any turn** → `lastContent()` is `""` → "no response to copy" (Task 2).
- **`/usage` before any turn** → `lastUsage()` is `undefined` → "no usage yet" (Task 2).
- **Engine-touching command after the engine is gone** (`/new`, `/status`): the awaited control rejects; caught by the `run()`-throw guard → "/<name> failed: <message>", returns `handled` (Task 2 throwing-command test).
- **Clipboard unavailable**: `clipboard()` rejects; `/copy` catches → "clipboard unavailable: <message>" (Task 2 + Task 3 reject tests).
- **`/status` / `/new` race**: both are `await`ed inside `handle`, which the loop `await`s before reading the next line — no second submit mid-command.
- **Name/alias collision on `register()`**: last registration wins. Overriding a command's **name** fully evicts the prior owner (all its keys, including its aliases) so the override replaces it cleanly; an **alias** collision is resolved per key (the alias points at the new command, the prior owner keeps its other keys). `/help` lists a command only if it still owns its own name key, so a command reachable only through a stolen alias never shows as a stale entry (Task 2: `/echo` seam test + the two collision tests covering a name override and an alias override).
- **Bare `/` and `/ …`**: empty candidate name → `submit` (Task 1).
- **Path-like `/tmp/foo`, `/etc/hosts`, `/a.b`**: fail the `^[a-zA-Z][\w-]*$` name check → `submit` (Task 1).

## Out of scope (per spec)

- `/resume` (session picker / log replay) — excluded.
- Mounted-mode slash interception — `classifyLine` + `SlashController` are built from generic deps so they can be reused in the ai-whisper adapter later, but no mounted wiring now.
- Any hax/C change — this is pure harness work.
