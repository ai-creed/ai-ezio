import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CortexSessionSink } from "./cortex-sink.js";
import type { RecordedTurn } from "./types.js";

const ref = { sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" };

function turn(i: number, tools: RecordedTurn["toolCalls"] = []): RecordedTurn {
	return {
		ref,
		index: i,
		timestamp: "",
		userText: `u${i}`,
		assistantText: `a${i}`,
		toolCalls: tools,
	};
}

describe("CortexSessionSink", () => {
	it("appends two projection lines per turn with monotonic turn numbers", () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const sink = new CortexSessionSink({
			host: { callHostTool: vi.fn() },
			stateDir: dir,
			repoKey: "repo",
		});
		sink.onTurnComplete(turn(0));
		sink.onTurnComplete(turn(1));

		const file = join(dir, "sessions", "repo", "s1-0.cortex.jsonl");
		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines.map((l) => l.turn)).toEqual([0, 1, 2, 3]);
		expect(lines[0]).toEqual({
			type: "user",
			turn: 0,
			message: { content: [{ type: "text", text: "u0" }] },
		});
	});

	it("flush calls capture_session via the host with the projection path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const callHostTool = vi
			.fn()
			.mockResolvedValue({ output: '{"status":"captured"}', status: "ok" });
		const sink = new CortexSessionSink({ host: { callHostTool }, stateDir: dir, repoKey: "repo" });
		sink.onTurnComplete(turn(0));
		await sink.flush(ref, "debounce");

		expect(callHostTool).toHaveBeenCalledWith("cortex__capture_session", {
			worktreePath: "/repo",
			sessionId: "s1-0",
			transcriptPath: join(dir, "sessions", "repo", "s1-0.cortex.jsonl"),
			embed: true,
		});
	});

	it("swallows a capture failure (fire-and-forget) and warns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const warn = vi.fn();
		const sink = new CortexSessionSink({
			host: { callHostTool: vi.fn().mockRejectedValue(new Error("down")) },
			stateDir: dir,
			repoKey: "repo",
			warn,
		});
		await expect(sink.flush(ref, "close")).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("capture failed"));
	});

	it("tolerates overlapping flushes + a skipped-locked result (no throw, no block, no warn)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const warn = vi.fn();
		// cortex's per-session lock: the first capture runs; a racing second returns
		// `skipped-locked` (a normal idempotent outcome carried in the OK payload, NOT an error).
		const callHostTool = vi
			.fn()
			.mockResolvedValueOnce({ output: '{"status":"captured","turnsProcessed":1}', status: "ok" })
			.mockResolvedValueOnce({ output: '{"status":"skipped-locked"}', status: "ok" });
		const sink = new CortexSessionSink({
			host: { callHostTool },
			stateDir: dir,
			repoKey: "repo",
			warn,
		});
		sink.onTurnComplete(turn(0));

		// Two boundary triggers race (e.g. debounce timer fires as /new arrives):
		const results = await Promise.all([sink.flush(ref, "debounce"), sink.flush(ref, "new")]);

		expect(results).toEqual([undefined, undefined]); // both resolve — the loop is never blocked
		expect(callHostTool).toHaveBeenCalledTimes(2);
		expect(warn).not.toHaveBeenCalled(); // skipped-locked is success, not a failure to surface
	});
});
