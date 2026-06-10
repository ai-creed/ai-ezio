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
