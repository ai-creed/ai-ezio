import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRecorder } from "./factory.js";

describe("createRecorder", () => {
	it("wires store + cortex sink: a completed turn writes both artifacts and a boundary captures", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "ezio-factory-"));
		const callHostTool = vi.fn().mockResolvedValue({ output: "{}", status: "ok" });
		const rec = createRecorder({
			worktreePath: "/repo",
			host: { callHostTool },
			stateDir,
			repoKey: "repo",
			everyKTurns: 100,
			idleDebounceMs: 100_000,
		});

		rec.handleEvent({ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" });
		rec.noteSubmit("hi");
		rec.handleEvent({ type: "user_turn_started", turnId: "t1" });
		rec.handleEvent({ type: "assistant_turn_finished", turnId: "t1", content: "hello" });
		rec.handleEvent({ type: "idle" });
		rec.close();
		await Promise.resolve();

		const cortexFile = join(stateDir, "sessions", "repo", "s1-0.cortex.jsonl");
		const recordFile = join(stateDir, "sessions", "repo", "s1-0.record.jsonl");
		expect(readFileSync(cortexFile, "utf8")).toContain('"type":"user"');
		expect(readFileSync(recordFile, "utf8")).toContain('"userText":"hi"');
		expect(callHostTool).toHaveBeenCalledWith("cortex__capture_session", expect.objectContaining({ sessionId: "s1-0" }));
	});
});
