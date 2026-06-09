import { describe, expect, it, vi } from "vitest";
import { SessionRecorder } from "./recorder.js";
import type { RecordedTurn, SessionSink } from "./types.js";
import type { ProtocolEvent } from "@ai-ezio/protocol";

function fakeSink() {
	const turns: RecordedTurn[] = [];
	const sink: SessionSink = {
		onTurnComplete: (t) => void turns.push(t),
		flush: vi.fn(),
	};
	return { sink, turns };
}

function feed(rec: SessionRecorder, events: ProtocolEvent[]) {
	for (const e of events) rec.handleEvent(e);
}

describe("SessionRecorder assembly", () => {
	it("assembles a turn: user text echo, tool calls, final content + usage", () => {
		const { sink, turns } = fakeSink();
		const store = { append: vi.fn() };
		const rec = new SessionRecorder({ worktreePath: "/repo", store, sink, idleDebounceMs: 9_999, everyKTurns: 999 });

		rec.noteSubmit("look at foo.ts"); // authoritative source: the text ezio itself sent
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1" }, // NOTE: no `text` echo — correlation must come from noteSubmit
			{ type: "assistant_turn_started", turnId: "t1" },
			{ type: "tool_call_started", turnId: "t1", name: "Read", callId: "c1", args: "src/foo.ts" },
			{ type: "tool_call_finished", turnId: "t1", name: "Read", callId: "c1", status: "ok", output: "…", isDiff: false },
			{ type: "assistant_turn_finished", turnId: "t1", content: "Done.", usage: { outputTokens: 12, contextTokens: 400 } },
			{ type: "idle" },
		]);

		expect(turns).toHaveLength(1);
		const turn = turns[0]!;
		expect(turn.ref).toEqual({ sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" });
		expect(turn.userText).toBe("look at foo.ts");
		expect(turn.assistantText).toBe("Done.");
		expect(turn.usage).toEqual({ outputTokens: 12, contextTokens: 400 });
		expect(turn.toolCalls).toEqual([
			{ name: "Read", input: "src/foo.ts", status: "ok", output: "…", isDiff: false },
		]);
		expect(store.append).toHaveBeenCalledWith(turn);
	});

	it("prefers the stashed submit text over the protocol echo", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		rec.noteSubmit("authoritative");
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "echo-only" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "" },
			{ type: "idle" },
		]);
		expect(turns[0]!.userText).toBe("authoritative");
	});

	it("falls back to the protocol echo when no submit was stashed", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "echo-fallback" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "" },
			{ type: "idle" },
		]);
		expect(turns[0]!.userText).toBe("echo-fallback");
	});

	it("upgrades a delegated tool's input from the requested args object", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "recall" },
			{ type: "tool_call_started", turnId: "t1", name: "cortex__recall_memory", callId: "c1", args: "query=x" },
			{ type: "tool_call_requested", turnId: "t1", name: "cortex__recall_memory", callId: "c1", args: { query: "x" } },
			{ type: "tool_call_finished", turnId: "t1", name: "cortex__recall_memory", callId: "c1", status: "ok" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "" },
			{ type: "idle" },
		]);
		expect(turns[0]!.toolCalls[0]!.input).toEqual({ query: "x" });
	});

	it("finalizes a partial turn at idle even with no assistant content (interrupt/error)", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "do a thing" },
			{ type: "error", message: "boom", turnId: "t1" },
			{ type: "idle" },
		]);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.assistantText).toBe("");
	});

	it("ignores a stray idle with no open turn", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "idle" },
		]);
		expect(turns).toHaveLength(0);
	});
});

describe("SessionRecorder trigger policy", () => {
	function ready(rec: SessionRecorder) {
		rec.handleEvent({ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" });
	}
	function oneTurn(rec: SessionRecorder, n: number) {
		rec.handleEvent({ type: "user_turn_started", turnId: `t${n}`, text: `u${n}` });
		rec.handleEvent({ type: "assistant_turn_finished", turnId: `t${n}`, content: `a${n}` });
		rec.handleEvent({ type: "idle" });
	}

	it("does NOT flush on every turn; flushes after the idle debounce", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
			idleDebounceMs: 10_000,
			everyKTurns: 100,
		});
		ready(rec);
		oneTurn(rec, 1);
		oneTurn(rec, 2);
		expect(flush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10_000);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" },
			"debounce",
		);
		vi.useRealTimers();
	});

	it("force-flushes every K turns", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
			idleDebounceMs: 10_000,
			everyKTurns: 3,
		});
		ready(rec);
		oneTurn(rec, 1);
		oneTurn(rec, 2);
		oneTurn(rec, 3);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenLastCalledWith(expect.anything(), "everyK");
		vi.useRealTimers();
	});

	it("flushes and rotates the conversation id on new_conversation", () => {
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
		});
		ready(rec);
		oneTurn(rec, 1);
		rec.noteNewConversation();
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" },
			"new",
		);
		oneTurn(rec, 2);
		rec.close();
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-1", worktreePath: "/repo" },
			"close",
		);
	});

	it("rapid overlapping boundary triggers never throw or block (fire-and-forget; cortex's lock dedupes)", () => {
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
		});
		ready(rec);
		oneTurn(rec, 1);
		// Boundaries fire back-to-back with no awaiting between them — never throws or
		// blocks. Only the FIRST boundary has an uncaptured turn; the empty repeats and
		// the close are recorder-level no-ops (cortex never even sees redundant captures).
		expect(() => {
			rec.noteNewConversation();
			rec.noteNewConversation();
			void rec.close();
		}).not.toThrow();
		expect(flush.mock.calls.map((c) => c[1])).toEqual(["new"]);
	});

	it("new_conversation before any turn is a capture no-op but still rotates the id (spec §5)", () => {
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
		});
		ready(rec);
		rec.noteNewConversation(); // before any turn → no flush
		expect(flush).not.toHaveBeenCalled();
		// …but the id rotated: the next captured turn lands in conversation s1-1.
		oneTurn(rec, 1);
		void rec.close();
		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-1", worktreePath: "/repo" },
			"close",
		);
	});
});
