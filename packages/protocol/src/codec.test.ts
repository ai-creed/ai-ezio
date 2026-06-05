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

	it("reassembles a multibyte UTF-8 char split across two byte chunks", () => {
		// The fd-3 reader yields raw Buffer chunks at arbitrary boundaries. A
		// multibyte codepoint (em-dash `—` = 0xE2 0x80 0x94) straddling a read
		// must NOT decode to `�`; the decoder has to hold back the partial bytes.
		const d = new JsonlDecoder();
		const line = `${JSON.stringify({ type: "assistant_turn_finished", turnId: "t", content: "a—b" })}\n`;
		const bytes = Buffer.from(line, "utf8");
		const split = bytes.indexOf(0x94); // mid em-dash (last continuation byte)
		expect(d.push(bytes.subarray(0, split))).toEqual([]); // ends mid-codepoint
		const out = d.push(bytes.subarray(split));
		expect(out).toEqual([
			{ type: "assistant_turn_finished", turnId: "t", content: "a—b" },
		]);
	});

	it("reassembles a multibyte char even when the split also breaks the line", () => {
		// Two independent boundary hazards at once: the byte split lands mid-`•`
		// (0xE2 0x80 0xA2) AND before the newline — both must be buffered.
		const d = new JsonlDecoder();
		const line = `${JSON.stringify({ type: "assistant_turn_finished", turnId: "t", content: "• item" })}\n`;
		const bytes = Buffer.from(line, "utf8");
		const split = bytes.indexOf(0x80); // mid bullet
		expect(d.push(bytes.subarray(0, split))).toEqual([]);
		const out = d.push(bytes.subarray(split));
		expect(out).toEqual([
			{ type: "assistant_turn_finished", turnId: "t", content: "• item" },
		]);
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

describe("M8 tool fields (tool_call_started.args, tool_call_finished.output/isDiff)", () => {
	it("round-trips tool args/output/isDiff", () => {
		const started = { type: "tool_call_started", turnId: "t", name: "bash", callId: "c", args: "ls -la" } satisfies ProtocolEvent;
		const finished = { type: "tool_call_finished", turnId: "t", name: "bash", callId: "c", status: "ok", output: "README.md\nsrc/", isDiff: false } satisfies ProtocolEvent;
		const d = new JsonlDecoder();
		const out = [...d.push(encodeEvent(started)), ...d.push(encodeEvent(finished))];
		expect(out[0]).toMatchObject({ type: "tool_call_started", args: "ls -la" });
		expect(out[1]).toMatchObject({ type: "tool_call_finished", output: "README.md\nsrc/", isDiff: false });
	});

	it("absence stays absent (no args key on a bare tool_call_started)", () => {
		const started = { type: "tool_call_started", turnId: "t", name: "bash", callId: "c" } satisfies ProtocolEvent;
		const line = encodeEvent(started);
		expect(line).not.toContain("args");
		const [dec] = new JsonlDecoder().push(line);
		expect(Object.prototype.hasOwnProperty.call(dec, "args")).toBe(false);
	});
});
