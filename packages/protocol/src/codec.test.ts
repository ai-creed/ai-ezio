import { describe, expect, it } from "vitest";
import { encodeControl, encodeEvent, JsonlDecoder, MalformedLineError } from "./codec.js";
import type { ProtocolEvent } from "./events.js";

describe("encodeControl", () => {
	it("emits one newline-terminated JSON line", () => {
		expect(encodeControl({ type: "submit", text: "hi" })).toBe('{"type":"submit","text":"hi"}\n');
		expect(encodeControl({ type: "interrupt" })).toBe('{"type":"interrupt"}\n');
	});
});

describe("JsonlDecoder", () => {
	it("round-trips every event type", () => {
		const events: ProtocolEvent[] = [
			{ type: "ready", sessionId: "s", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "hi" },
			{ type: "assistant_turn_started", turnId: "t1" },
			{ type: "assistant_delta", turnId: "t1", text: "he" },
			{ type: "tool_call_started", turnId: "t1", name: "bash", callId: "c1" },
			{ type: "tool_call_finished", turnId: "t1", name: "bash", callId: "c1", status: "ok" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "hello" },
			{ type: "error", message: "boom", turnId: "t1" },
			{
				type: "status",
				model: "m",
				provider: "mock",
				protocol: "0.1.0",
				sessionId: "s",
				state: "idle",
				contextPercent: null,
			},
			{ type: "idle" },
		];
		const wire = events.map((e) => `${JSON.stringify(e)}\n`).join("");
		const decoded = new JsonlDecoder().push(wire);
		expect(decoded).toEqual(events);
	});

	it("buffers a line split across chunks", () => {
		const d = new JsonlDecoder();
		expect(d.push('{"type":"idle"')).toEqual([]);
		expect(d.pending).toBe('{"type":"idle"');
		expect(d.push("}\n")).toEqual([{ type: "idle" }]);
		expect(d.pending).toBe("");
	});

	it("emits multiple events from one chunk and keeps a trailing partial", () => {
		const d = new JsonlDecoder();
		const out = d.push(
			'{"type":"idle"}\n{"type":"assistant_turn_started","turnId":"t1"}\n{"type":"idl',
		);
		expect(out).toEqual([{ type: "idle" }, { type: "assistant_turn_started", turnId: "t1" }]);
		expect(d.pending).toBe('{"type":"idl');
	});

	it("ignores blank lines", () => {
		expect(new JsonlDecoder().push('\n\n{"type":"idle"}\n\n')).toEqual([{ type: "idle" }]);
	});

	it("surfaces a malformed line as MalformedLineError", () => {
		expect(() => new JsonlDecoder().push("not json\n")).toThrow(MalformedLineError);
	});
});

describe("M7 optional fields (status.effort, assistant_turn_finished.usage)", () => {
	it("round-trips status.effort and assistant_turn_finished.usage", () => {
		const status = {
			type: "status",
			model: "gpt-5.5",
			provider: "codex",
			protocol: "0.1.0",
			sessionId: "s1",
			state: "idle",
			contextPercent: null,
			effort: "high",
		} satisfies ProtocolEvent;
		const finished = {
			type: "assistant_turn_finished",
			turnId: "t1",
			content: "done",
			usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 },
		} satisfies ProtocolEvent;

		const dec = new JsonlDecoder();
		const out = [...dec.push(encodeEvent(status)), ...dec.push(encodeEvent(finished))];
		expect(out[0]).toMatchObject({ type: "status", effort: "high" });
		expect(out[1]).toMatchObject({
			type: "assistant_turn_finished",
			usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 },
		});
	});

	it("absence stays absent: no usage key / no `usage: undefined` leakage", () => {
		const finished = {
			type: "assistant_turn_finished",
			turnId: "t1",
			content: "done",
		} satisfies ProtocolEvent;
		const line = encodeEvent(finished);
		expect(line).not.toContain("usage");
		const [decoded] = new JsonlDecoder().push(line);
		expect(Object.prototype.hasOwnProperty.call(decoded, "usage")).toBe(false);

		const status = {
			type: "status",
			model: "m",
			provider: "p",
			protocol: "0.1.0",
			sessionId: "s",
			state: "idle",
			contextPercent: null,
		} satisfies ProtocolEvent;
		const [d2] = new JsonlDecoder().push(encodeEvent(status));
		expect(Object.prototype.hasOwnProperty.call(d2, "effort")).toBe(false);
	});
});
