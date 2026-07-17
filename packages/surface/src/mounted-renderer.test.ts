import { describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createMountedRenderer } from "./mounted-renderer.js";

function setup(opts?: { utf8?: boolean; columns?: number }) {
	const writes: string[] = [];
	const stdout = {
		write: (s: string) => (writes.push(s), true),
		columns: opts?.columns ?? 80,
	} as never;
	let cb: (() => void) | null = null;
	const set = vi.fn((fn: () => void) => {
		cb = fn;
		return 1 as never;
	});
	const clear = vi.fn();
	let nowMs = 0;
	const r = createMountedRenderer({
		stdout,
		utf8: opts?.utf8 ?? true,
		setInterval: set,
		clearInterval: clear,
		now: () => nowMs,
	});
	return {
		r,
		out: () => writes.join(""),
		writes,
		set,
		clear,
		tick: () => cb?.(),
		setNow: (t: number) => (nowMs = t),
	};
}

const STATUS: ProtocolEvent = {
	type: "status",
	model: "gpt-5.5",
	provider: "codex",
	protocol: "0.1.0",
	sessionId: "s",
	state: "idle",
	effort: "high",
};

describe("createMountedRenderer", () => {
	it("emits real ESC bytes (\\u001b), not literal bracket codes", () => {
		// Regression guard: the renderer's ESC constant was once an empty string,
		// so every ANSI code shipped as literal text ("[95m") that terminals print
		// verbatim instead of interpreting. Assert a real ESC precedes a code.
		const t = setup();
		t.r.handle(STATUS); // banner
		t.r.handle({ type: "idle" }); // prompt
		expect(t.out()).toContain("\u001b[36m"); // banner cyan with a REAL escape
		expect(t.out()).toContain("\u001b[95m"); // prompt bright magenta with a REAL escape
	});

	it("renders the banner exactly once across repeated status events", () => {
		const t = setup();
		t.r.handle(STATUS);
		t.r.handle(STATUS);
		expect((t.out().match(/ezio/g) || []).length).toBe(1);
		expect(t.out()).toContain("codex");
		expect(t.out()).toContain("gpt-5.5");
		expect(t.out()).toContain("high");
	});

	it("re-renders the banner after a respawn (ready resets the one-shot flag)", () => {
		// Simulates: first launch → ready+status (banner 1), then /resume → ready+status (banner 2).
		const t = setup();
		const READY: ProtocolEvent = {
			type: "ready",
			sessionId: "s1",
			protocol: "0.1.0",
			haxBaseCommit: "x",
		};
		const STATUS2: ProtocolEvent = {
			type: "status",
			model: "gpt-6",
			provider: "openai",
			protocol: "0.1.0",
			sessionId: "s2",
			state: "idle",
			effort: "low",
		};

		// First launch: ready then status → one banner.
		t.r.handle(READY);
		t.r.handle(STATUS);
		expect((t.out().match(/ezio/g) || []).length).toBe(1);

		// Respawn: a second ready resets the flag; status re-renders the banner.
		t.r.handle(READY);
		t.r.handle(STATUS2);
		const out = t.out();
		// Two banners total — the second one shows the new model.
		expect((out.match(/ezio/g) || []).length).toBe(2);
		expect(out).toContain("gpt-6");
		expect(out).toContain("openai");

		// A third status (no intervening ready) does NOT add a third banner.
		t.r.handle(STATUS2);
		expect((t.out().match(/ezio/g) || []).length).toBe(2);
	});

	it("no-raw-delta: an assistant_delta writes nothing to the pane", () => {
		const t = setup();
		t.r.handle({ type: "assistant_delta", turnId: "t", text: "hello" });
		expect(t.out()).toBe("");
	});

	it("renders the final content as markdown at turn end", () => {
		const t = setup();
		t.r.handle({ type: "assistant_turn_finished", turnId: "t", content: "**hi**" });
		t.r.handle({ type: "idle" });
		expect(t.out()).toContain("\u001b[1mhi\u001b[0m"); // bold-rendered markdown
	});

	it("renders a markdown table as a bordered grid (no raw pipes)", () => {
		const t = setup();
		t.r.handle({
			type: "assistant_turn_finished",
			turnId: "t",
			content: "| A | B |\n| --- | --- |\n| 1 | 2 |",
		});
		const out = t.out();
		expect(out).toContain("A");
		expect(out).toContain("1");
		// box-drawing glyph proves the robust renderer ran (the original raw-pipe bug)
		expect(/[│┌─]/u.test(out)).toBe(true);
	});

	it("spinner: shown after user_turn_started, cleared on first output", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t" });
		expect(t.set).toHaveBeenCalled();
		expect(t.out()).toContain("thinking");
		t.r.handle({ type: "assistant_turn_finished", turnId: "t", content: "done" });
		expect(t.clear).toHaveBeenCalled();
		expect(t.out()).toContain("\r"); // clear-line carriage return
	});

	it("spinner idle-safety: timer cleared on idle, no frame after idle", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t" });
		t.r.handle({ type: "idle" });
		expect(t.clear).toHaveBeenCalled();
		const before = t.out().length;
		t.tick(); // invoke the captured interval callback AFTER idle
		expect(t.out().length).toBe(before); // no spinner frame written post-idle
	});

	it("tool: renders ⏺ name · args, a colored diff, a dim preview, and error status", () => {
		const t = setup();
		t.r.handle({
			type: "tool_call_started",
			turnId: "t",
			name: "bash",
			callId: "c",
			args: "ls -la",
		});
		expect(t.out()).toContain("⏺");
		expect(t.out()).toContain("bash");
		expect(t.out()).toContain("ls -la");

		const d = setup();
		d.r.handle({
			type: "tool_call_finished",
			turnId: "t",
			name: "edit",
			callId: "c",
			status: "ok",
			output: "--- a\n+++ b\n+added\n-removed\n",
			isDiff: true,
		});
		expect(d.out()).toContain("[32m"); // green + line
		expect(d.out()).toContain("[31m"); // red - line

		const p = setup();
		p.r.handle({
			type: "tool_call_finished",
			turnId: "t",
			name: "bash",
			callId: "c",
			status: "ok",
			output: "l1\nl2\nl3\nl4\nl5\nl6\n",
			isDiff: false,
		});
		expect(p.out()).toContain("[2m"); // dim preview
		expect(p.out()).toContain("l1");

		const e = setup();
		e.r.handle({
			type: "tool_call_finished",
			turnId: "t",
			name: "bash",
			callId: "c",
			status: "error",
			output: "boom",
			isDiff: false,
		});
		expect(e.out()).toContain("[31m"); // red error status
	});

	it("stats line begins on its own line (M7 glue-bug fix)", () => {
		const t = setup();
		t.r.handle({
			type: "assistant_turn_finished",
			turnId: "t",
			content: "answer",
			usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 },
		});
		t.r.handle({ type: "idle" });
		const out = t.out();
		expect(out).toMatch(/8\.7k \/ 256k \(3%\)/);
		expect(out).toMatch(/\n[^\n]*8\.7k \/ 256k/); // a newline precedes the stats line
	});

	it("prompt parity: ❯ under UTF-8, > fallback otherwise", () => {
		const u = setup({ utf8: true });
		u.r.handle({ type: "idle" });
		expect(u.out()).toContain("❯");
		expect(u.out()).toContain("[95m"); // bright magenta, matching hax's purple prompt

		const a = setup({ utf8: false });
		a.r.handle({ type: "idle" });
		expect(a.out()).toContain("> ");
		expect(a.out()).not.toContain("❯");
	});

	it("non-turn (fatal) error renders red AND draws its own prompt (no idle follows)", () => {
		const t = setup({ utf8: true });
		t.r.handle({ type: "error", message: "boom" }); // no turnId → fatal/non-turn
		const out = t.out();
		expect(out).toContain("[31m"); // red
		expect(out).toContain("boom");
		expect(out).toContain("❯"); // trailing prompt — pane usable again
		expect((out.match(/❯/g) || []).length).toBe(1);
	});

	it("turn-scoped error draws exactly ONE prompt — idle owns it, not the error", () => {
		// Harness contract (fake-engine error mode, session.e2e.test.ts): a
		// turn-scoped error drains to idle —
		//   error(turnId) → assistant_turn_finished(content:"") → idle
		// The error handler must NOT draw a prompt or the pane shows two.
		const t = setup({ utf8: true });
		t.r.handle({ type: "error", message: "boom", turnId: "x" });
		t.r.handle({ type: "assistant_turn_finished", turnId: "x", content: "" });
		t.r.handle({ type: "idle" });
		const out = t.out();
		expect(out).toContain("boom");
		expect((out.match(/❯/g) || []).length).toBe(1); // exactly one prompt
	});

	it("echoUserInput paints a bright-magenta ▌ stripe + body, one trailing newline", () => {
		const t = setup({ utf8: true });
		t.r.echoUserInput("hello world", 80);
		const out = t.out();
		expect(out).toContain("[95m"); // bright magenta (hax stripe)
		expect(out).toContain("▌ hello world");
		expect(out.endsWith("\n")).toBe(true);
		expect((out.match(/▌ /g) || []).length).toBe(1); // single visual row
	});

	it("echoUserInput re-stripes every wrapped visual row (char-wrap by cell width)", () => {
		const t = setup({ utf8: true });
		// cols=7 → body width = 7-2 = 5; 12 ASCII chars (1 cell each) → 5/5/2 = 3 stripes.
		t.r.echoUserInput("abcdefghijkl", 7);
		const out = t.out();
		expect((out.match(/▌ /g) || []).length).toBe(3);
		expect(out).toContain("▌ abcde");
		expect(out).toContain("▌ fghij");
		expect(out).toContain("▌ kl");
	});

	it("echoUserInput wraps by terminal CELL width, not code-point count (wide chars = 2 cells)", () => {
		const t = setup({ utf8: true });
		// cols=7 → body width = 5 cells. Four wide CJK chars (2 cells each = 8 cells)
		// must wrap to rows of 2 chars (4 cells). Code-point counting would keep all
		// four on one row (4 code points ≤ 5) — that was the bug.
		t.r.echoUserInput("一二三四", 7);
		const out = t.out();
		expect((out.match(/▌ /g) || []).length).toBe(2);
		expect(out).toContain("▌ 一二");
		expect(out).toContain("▌ 三四");
	});

	it("echoUserInput counts zero-width combining marks as 0 cells", () => {
		const t = setup({ utf8: true });
		// "aé" as a + e + combining acute (U+0301): 3 code points, 2 cells. cols=4 →
		// body width 2 → fits one row. Code-point counting would split it into two.
		t.r.echoUserInput("ae\u0301", 4);
		const out = t.out();
		expect((out.match(/▌ /g) || []).length).toBe(1);
	});

	it("echoUserInput uses an ASCII | stripe when utf8 is off", () => {
		const t = setup({ utf8: false });
		t.r.echoUserInput("hi", 80);
		const out = t.out();
		expect(out).toContain("| hi");
		expect(out).not.toContain("▌");
	});

	it("echoSubmittedInput erases the echoed input row and repaints the magenta block", () => {
		const t = setup();
		t.r.echoSubmittedInput("hello");
		const out = t.out();
		expect(out).toContain("[2K"); // cleared the echoed line
		expect(out).not.toContain("[1A"); // single row → no cursor-up
		expect(out).toContain("▌ hello");
		expect(out).toContain("[95m"); // bright magenta
	});

	it("echoSubmittedInput erases every wrapped row (prompt + text across cols)", () => {
		const t = setup({ columns: 7 });
		// prompt 2 cells + 12 ASCII cells = 14; at width 7 → ceil(14/7) = 2 rows.
		t.r.echoSubmittedInput("abcdefghijkl");
		const out = t.out();
		expect((out.match(/\[1A/g) || []).length).toBe(1); // 2 rows → 1 cursor-up
		expect((out.match(/\[2K/g) || []).length).toBe(2); // both rows cleared
	});

	it("echoSubmittedInput counts embedded newlines as separate rows (Alt+Enter input)", () => {
		const t = setup();
		// "a\nb": line1 = prompt(2)+1 = 3 cells → 1 row; line2 = 1 cell → 1 row; total 2.
		t.r.echoSubmittedInput("a\nb");
		const out = t.out();
		expect((out.match(/\[1A/g) || []).length).toBe(1);
		expect((out.match(/\[2K/g) || []).length).toBe(2);
	});

	it("renderPrompt writes a fresh bright-magenta prompt on its own line", () => {
		const t = setup();
		t.r.renderPrompt();
		const out = t.out();
		expect(out.startsWith("\n")).toBe(true);
		expect(out).toContain("❯");
		expect(out).toContain("[95m");
	});

	it("exposes the public API (handle + echoUserInput + echoSubmittedInput + renderPrompt)", () => {
		const t = setup();
		expect(typeof t.r.handle).toBe("function");
		expect(typeof t.r.echoUserInput).toBe("function");
		expect(typeof t.r.echoSubmittedInput).toBe("function");
		expect(typeof t.r.renderPrompt).toBe("function");
	});
});

const TOOL_START: ProtocolEvent = {
	type: "tool_call_started",
	turnId: "t1",
	callId: "c1",
	name: "bash",
	args: "ls",
};
const TOOL_END: ProtocolEvent = {
	type: "tool_call_finished",
	turnId: "t1",
	callId: "c1",
	name: "bash",
	status: "ok",
	output: "ok",
};

describe("spinner row discipline", () => {
	it("keeps spinning during a tool run, parked below the tool header", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.tick(); // spinner visible
		t.r.handle(TOOL_START); // content write must clear the spinner row first
		const afterHeader = t.writes.length;
		t.tick(); // spinner re-parks BELOW the header: first frame opens a new row
		const reopened = t.writes.slice(afterHeader).join("");
		expect(reopened.startsWith("\n")).toBe(true); // new row before the frame
		expect(reopened).toContain("thinking…"); // young tool phase keeps settled label
	});

	it("keeps spinning through tool finish and returns to thinking once settled", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.setNow(2500); // thinking settled
		t.r.handle(TOOL_START);
		t.setNow(4500); // tool held SETTLE_MS
		t.tick();
		expect(t.out()).toContain("[bash] running…");
		t.r.handle(TOOL_END); // tool finished — the spinner must stay alive
		expect(t.clear).not.toHaveBeenCalled(); // interval NOT stopped by tool finish
		t.setNow(6500); // post-tool thinking (since 4500) settles again
		t.tick();
		// The frame drawn AFTER tool finish proves post-tool liveness.
		expect(t.writes[t.writes.length - 1]).toContain("thinking…");
	});

	it("stops the interval when the turn ends", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.r.handle({ type: "idle" });
		expect(t.clear).toHaveBeenCalled();
	});

	it("renders no context figure at idle when the turn reported no usage", () => {
		// A turn with no usage still renders a duration-only statsLine (e.g. "3s");
		// this pins that the duration-only line never carries a "context" figure,
		// not that no stats line renders at all.
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.r.handle({ type: "assistant_turn_finished", turnId: "t1", content: "" });
		t.r.handle({ type: "idle" });
		expect(t.out()).not.toContain("context ");
	});

	it("renders the elapsed counter on a long turn", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.setNow(31_000);
		t.tick();
		expect(t.out()).toContain("31s · thinking…");
	});
});

describe("stats line", () => {
	const finish = (
		usage?: import("@ai-ezio/protocol").AssistantTurnFinishedEvent["usage"],
	): ProtocolEvent => ({ type: "assistant_turn_finished", turnId: "t1", content: "", usage });

	it("renders duration-led narrow→wide with an unlabeled gauge when the limit is known", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.setNow(42_000);
		t.r.handle(finish({ contextTokens: 9114, contextLimit: 262144 }));
		t.r.handle({ type: "idle" });
		expect(t.out()).toContain("42s · 8.9k / 256k (3%)");
		expect(t.out()).not.toContain("context 8.9k");
		expect(t.out()).not.toContain("out ");
		expect(t.out()).not.toContain("cached ");
	});

	it("labels the context figure when the limit is unknown", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.setNow(5_000);
		t.r.handle(finish({ contextTokens: 9114 }));
		t.r.handle({ type: "idle" });
		expect(t.out()).toContain("5s · context 8.9k");
	});

	it("renders duration alone when the turn reported no usage", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.setNow(3_000);
		t.r.handle(finish(undefined));
		t.r.handle({ type: "idle" });
		expect(t.out()).toContain("3s");
	});

	it("suppresses the stats line for an errored turn", () => {
		const t = setup();
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.setNow(4_000);
		t.r.handle({ type: "error", turnId: "t1", message: "boom" });
		t.r.handle(finish({ contextTokens: 9114, contextLimit: 262144 }));
		t.r.handle({ type: "idle" });
		expect(t.out()).not.toContain("8.9k / 256k");
		expect(t.out()).not.toContain("4s ·");
	});
});

const CLEAR = "\r\x1b[2K";

/** Assert the content write carrying `marker` was preceded — after the last
 * live spinner frame — by a clear-line chunk. Proves THAT content path
 * cleared the spinner row (not an unrelated earlier clear: the scan starts
 * at the last frame drawn before the content). */
function expectClearedBeforeMarker(writes: string[], marker: string) {
	const contentIdx = writes.findIndex((s) => s.includes(marker));
	expect(contentIdx).toBeGreaterThan(-1);
	let lastFrameIdx = -1;
	for (let i = 0; i < contentIdx; i++) {
		const s = writes[i] ?? "";
		if (s.includes("thinking…") || s.includes("working…") || s.includes("running…"))
			lastFrameIdx = i;
	}
	expect(lastFrameIdx).toBeGreaterThan(-1); // spinner was live before the content
	expect(writes.slice(lastFrameIdx + 1, contentIdx).join("")).toContain(CLEAR);
}

describe("content writes clear the live spinner row", () => {
	// Each test makes the spinner row visible FIRST (tick), then dispatches one
	// content-producing event and asserts THAT path cleared the row — per the
	// spec, every content path must clear, not only terminal events whose
	// stopSpinnerInterval clears as a side effect.
	const begin = (t: ReturnType<typeof setup>) => {
		t.r.handle({ type: "user_turn_started", turnId: "t1" });
		t.tick(); // spinner row visible
	};

	it("tool header", () => {
		const t = setup();
		begin(t);
		t.r.handle(TOOL_START);
		expectClearedBeforeMarker(t.writes, "⏺ bash");
	});

	it("tool output preview", () => {
		const t = setup();
		begin(t);
		t.r.handle(TOOL_START);
		t.tick(); // spinner re-parked below the header — live again
		t.r.handle(TOOL_END); // output preview renders "  ok"
		expectClearedBeforeMarker(t.writes, "  ok");
	});

	it("markdown at turn end", () => {
		const t = setup();
		begin(t);
		t.r.handle({
			type: "assistant_turn_finished",
			turnId: "t1",
			content: "done",
		});
		expectClearedBeforeMarker(t.writes, "done");
	});

	it("stats line and prompt at idle", () => {
		const t = setup();
		begin(t);
		t.r.handle({
			type: "assistant_turn_finished",
			turnId: "t1",
			content: "",
			usage: { contextTokens: 9114, contextLimit: 262144 },
		});
		t.r.handle({ type: "idle" });
		// "8.9k / 256k" appears in both the Task 2 (old) and Task 3 (new) formats.
		expectClearedBeforeMarker(t.writes, "8.9k / 256k");
		expectClearedBeforeMarker(t.writes, "❯");
	});

	it("error line", () => {
		const t = setup();
		begin(t);
		t.r.handle({ type: "error", turnId: "t1", message: "boom" });
		expectClearedBeforeMarker(t.writes, "boom");
	});
});
