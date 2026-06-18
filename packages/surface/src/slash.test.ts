import { describe, expect, it } from "vitest";
import { classifyLine } from "./slash.js";

const KNOWN = new Set([
	"help",
	"new",
	"clear",
	"status",
	"skills",
	"copy",
	"usage",
	"quit",
	"exit",
]);

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
		const { ctx, out } = fakeCtx({
			session: {
				newConversation: async () => void called++,
				status: async () => ({}) as StatusEvent,
			},
		});
		const c = new SlashController(ctx);
		expect(await c.handle("/new")).toEqual({ action: "handled" });
		expect(called).toBe(1);
		expect(out()).toContain("new conversation");
	});

	it("/clear is an alias for /new", async () => {
		let called = 0;
		const { ctx } = fakeCtx({
			session: {
				newConversation: async () => void called++,
				status: async () => ({}) as StatusEvent,
			},
		});
		const c = new SlashController(ctx);
		expect(await c.handle("/clear")).toEqual({ action: "handled" });
		expect(called).toBe(1);
	});

	it("/status renders provider · model · effort and returns handled", async () => {
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		expect(await c.handle("/status")).toEqual({ action: "handled" });
		expect(out()).toContain("anthropic");
		expect(out()).toContain("claude-x");
		expect(out()).toContain("high");
	});

	it("/skills lists name · source, or a placeholder when empty (both return handled)", async () => {
		const empty = fakeCtx();
		expect(await new SlashController(empty.ctx).handle("/skills")).toEqual({ action: "handled" });
		expect(empty.out()).toContain("(no skills found)");

		const some = fakeCtx({
			skills: () => [{ name: "debugging", source: "project", description: "d" }],
		});
		expect(await new SlashController(some.ctx).handle("/skills")).toEqual({ action: "handled" });
		expect(some.out()).toContain("debugging");
		expect(some.out()).toContain("project");
	});

	it("/copy with content copies, reports byte count, and returns handled", async () => {
		let copied = "";
		const { ctx, out } = fakeCtx({
			lastContent: () => "héllo",
			clipboard: async (t) => void (copied = t),
		});
		expect(await new SlashController(ctx).handle("/copy")).toEqual({ action: "handled" });
		expect(copied).toBe("héllo");
		expect(out()).toContain(`copied ${Buffer.byteLength("héllo", "utf8")} bytes`);
	});

	it("/copy with no content → no response to copy (handled)", async () => {
		const { ctx, out } = fakeCtx({ lastContent: () => "" });
		expect(await new SlashController(ctx).handle("/copy")).toEqual({ action: "handled" });
		expect(out()).toContain("no response to copy");
	});

	it("/copy surfaces a rejecting clipboard as unavailable (handled)", async () => {
		const { ctx, out } = fakeCtx({
			lastContent: () => "x",
			clipboard: async () => {
				throw new Error("pbcopy not found");
			},
		});
		expect(await new SlashController(ctx).handle("/copy")).toEqual({ action: "handled" });
		expect(out()).toContain("clipboard unavailable");
		expect(out()).toContain("pbcopy not found");
	});

	it("/usage renders tracked usage, or a placeholder when absent (both return handled)", async () => {
		const none = fakeCtx({ lastUsage: () => undefined });
		expect(await new SlashController(none.ctx).handle("/usage")).toEqual({ action: "handled" });
		expect(none.out()).toContain("no usage yet");

		const some = fakeCtx({
			lastUsage: () => ({
				contextTokens: 100,
				outputTokens: 20,
				cachedTokens: 5,
				contextLimit: 200000,
			}),
		});
		expect(await new SlashController(some.ctx).handle("/usage")).toEqual({ action: "handled" });
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
		c.register({
			name: "fresh",
			aliases: ["clear"],
			summary: "fresh start",
			run: () => void (ran = true),
		});
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

describe("/transcript", () => {
	it("invokes the injected transcript view and returns handled", async () => {
		let shown = 0;
		const { ctx } = fakeCtx({ showTranscript: async () => void shown++ });
		const c = new SlashController(ctx);
		expect(await c.handle("/transcript")).toEqual({ action: "handled" });
		expect(shown).toBe(1);
	});

	it("reports unavailable when no view is wired (handled, never throws)", async () => {
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		expect(await c.handle("/transcript")).toEqual({ action: "handled" });
		expect(out()).toContain("transcript unavailable");
	});
});

describe("/compact (M11)", () => {
	it("runs the injected compactor", async () => {
		const calls: string[] = [];
		const { ctx, out } = fakeCtx({
			compactor: {
				compactNow: async () => {
					calls.push("now");
					return { kind: "compacted" };
				},
			},
		});
		const c = new SlashController(ctx);
		expect(await c.handle("/compact")).toEqual({ action: "handled" });
		expect(calls).toEqual(["now"]);
		expect(out()).toBe(""); // success chrome comes from the Compactor's onNote
	});

	it("reports an in-progress cycle", async () => {
		const { ctx, out } = fakeCtx({
			compactor: { compactNow: async () => ({ kind: "skipped", reason: "in-progress" }) },
		});
		const c = new SlashController(ctx);
		await c.handle("/compact");
		expect(out()).toContain("compaction already in progress");
	});

	it("reports unavailability when no compactor is wired", async () => {
		const { ctx, out } = fakeCtx();
		const c = new SlashController(ctx);
		await c.handle("/compact");
		expect(out()).toContain("compaction unavailable");
	});
});

describe("/usage fullness percent (M11)", () => {
	it("appends the percentage when tokens and limit are present", async () => {
		const { ctx, out } = fakeCtx({
			lastUsage: () => ({ contextTokens: 142000, outputTokens: 9, contextLimit: 200000 }),
		});
		const c = new SlashController(ctx);
		await c.handle("/usage");
		expect(out()).toContain("71%");
	});

	it("no percentage without a limit", async () => {
		const { ctx, out } = fakeCtx({ lastUsage: () => ({ contextTokens: 142000 }) });
		const c = new SlashController(ctx);
		await c.handle("/usage");
		expect(out()).not.toContain("%");
	});
});

describe("SlashController excludeCommands", () => {
	it("omits quit and its exit alias when excluded", async () => {
		const out: string[] = [];
		const { ctx } = fakeCtx({ write: (s) => out.push(s) });
		const ctrl = new SlashController(ctx, { excludeCommands: ["quit"] });

		const quit = await ctrl.handle("/quit");
		const exit = await ctrl.handle("/exit");

		expect(quit).toEqual({ action: "handled" });
		expect(exit).toEqual({ action: "handled" });
		expect(out.join("")).toContain("unknown command: /quit");
		expect(out.join("")).toContain("unknown command: /exit");
	});

	it("keeps quit -> exit by default", async () => {
		const { ctx } = fakeCtx();
		const ctrl = new SlashController(ctx);
		expect(await ctrl.handle("/quit")).toEqual({ action: "exit" });
	});
});

import { vi } from "vitest";
import { runResumeFlow, type ResumeFlowDeps } from "./slash.js";

function baseCtx(over: Partial<SlashContext> = {}): SlashContext {
	const out: string[] = [];
	return {
		write: (s) => void (out as string[]).push(s),
		session: { newConversation: async () => {}, status: async () => ({ provider: "p", model: "m" }) },
		lastContent: () => "",
		lastUsage: () => undefined,
		skills: () => [],
		clipboard: async () => {},
		...over,
		// expose captured output for assertions
		__out: out,
	} as unknown as SlashContext;
}

describe("/rename", () => {
	it("is unavailable when setSessionTitle is unwired", async () => {
		const ctx = baseCtx();
		const out: string[] = (ctx as unknown as { __out: string[] }).__out;
		await new SlashController(ctx).handle("/rename foo");
		expect(out.join("")).toContain("rename unavailable");
	});

	it("sets a non-empty title and echoes confirmation", async () => {
		const setSessionTitle = vi.fn();
		const ctx = baseCtx({ currentSessionId: () => "id", setSessionTitle, getSessionTitle: () => undefined });
		const out: string[] = (ctx as unknown as { __out: string[] }).__out;
		await new SlashController(ctx).handle("/rename  wire seam ");
		expect(setSessionTitle).toHaveBeenCalledWith("wire seam");
		expect(out.join("")).toContain('renamed to "wire seam"');
	});

	it("no-arg prints the current/pending title or a usage hint", async () => {
		const withTitle = baseCtx({ setSessionTitle: () => {}, getSessionTitle: () => "alpha" });
		const o1: string[] = (withTitle as unknown as { __out: string[] }).__out;
		await new SlashController(withTitle).handle("/rename");
		expect(o1.join("")).toContain("alpha");

		const noTitle = baseCtx({ setSessionTitle: () => {}, getSessionTitle: () => undefined });
		const o2: string[] = (noTitle as unknown as { __out: string[] }).__out;
		await new SlashController(noTitle).handle("/rename");
		expect(o2.join("")).toContain("no title set");
	});
});

describe("/resume command", () => {
	it("is unavailable when resume is unwired", async () => {
		const ctx = baseCtx();
		const out: string[] = (ctx as unknown as { __out: string[] }).__out;
		await new SlashController(ctx).handle("/resume");
		expect(out.join("")).toContain("resume unavailable");
	});

	it("delegates to ctx.resume() when wired", async () => {
		const resume = vi.fn(async () => {});
		const ctx = baseCtx({ resume });
		await new SlashController(ctx).handle("/resume");
		expect(resume).toHaveBeenCalledOnce();
	});
});

function flowDeps(over: Partial<ResumeFlowDeps> = {}): {
	deps: ResumeFlowDeps;
	out: string[];
	resumed: string[];
	fatal: { called: boolean };
} {
	const out: string[] = [];
	const resumed: string[] = [];
	const fatal = { called: false };
	const deps: ResumeFlowDeps = {
		write: (s) => void out.push(s),
		isBusy: () => false,
		listSessions: async () => JSON.stringify([{ id: "other", mtime: 1, firstPrompt: "p" }]),
		titles: () => new Map(),
		currentSessionId: () => undefined,
		now: () => 0,
		runOverlay: async (run) =>
			run({
				keys: (async function* () {
					yield "\r"; // Enter → select row 0
				})(),
				write: (s) => out.push(s),
				setRawMode: () => {},
			}),
		resume: async (id) => void resumed.push(id),
		onFatal: () => void (fatal.called = true),
		...over,
	};
	return { deps, out, resumed, fatal };
}

describe("runResumeFlow (§3)", () => {
	it("refuses while busy", async () => {
		const { deps, out, resumed } = flowDeps({ isBusy: () => true });
		await runResumeFlow(deps);
		expect(out.join("")).toContain("finish or interrupt the current turn first");
		expect(resumed).toEqual([]);
	});

	it("reports 'no other sessions' on an empty list", async () => {
		const { deps, out } = flowDeps({ listSessions: async () => "[]" });
		await runResumeFlow(deps);
		expect(out.join("")).toContain("no other sessions");
	});

	it("excludes the active session; selecting the only other one resumes it", async () => {
		const { deps, resumed } = flowDeps({
			listSessions: async () =>
				JSON.stringify([
					{ id: "active", mtime: 2, firstPrompt: "a" },
					{ id: "other", mtime: 1, firstPrompt: "b" },
				]),
			currentSessionId: () => "active",
		});
		await runResumeFlow(deps);
		expect(resumed).toEqual(["other"]); // "active" filtered out, never offered
	});

	it("takes the empty path when the only session is the active one", async () => {
		const { deps, out, resumed } = flowDeps({
			listSessions: async () => JSON.stringify([{ id: "active", mtime: 1, firstPrompt: "a" }]),
			currentSessionId: () => "active",
		});
		await runResumeFlow(deps);
		expect(out.join("")).toContain("no other sessions");
		expect(resumed).toEqual([]);
	});

	it("cancel (Esc) is a no-op (no resume, no onFatal)", async () => {
		const { deps, resumed, fatal } = flowDeps({
			runOverlay: async (run) =>
				run({ keys: (async function* () { yield "\x1b"; })(), write: () => {}, setRawMode: () => {} }),
		});
		await runResumeFlow(deps);
		expect(resumed).toEqual([]);
		expect(fatal.called).toBe(false);
	});

	it("respawn failure reports and exits cleanly (no fallback) — spec §4", async () => {
		const { deps, out, fatal } = flowDeps({
			resume: async () => {
				throw new Error("bad id");
			},
		});
		await runResumeFlow(deps);
		expect(out.join("")).toContain("resume failed: bad id");
		expect(fatal.called).toBe(true); // teardown invoked; no fresh fallback session
	});
});
