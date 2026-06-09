import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recoverUncaptured } from "./recovery.js";

describe("recoverUncaptured", () => {
	it("triggers capture_session once per on-disk projection file", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "ezio-recover-"));
		const dir = join(stateDir, "sessions", "repo");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "s1-0.cortex.jsonl"), "{}\n");
		writeFileSync(join(dir, "s1-1.cortex.jsonl"), "{}\n");
		writeFileSync(join(dir, "notes.txt"), "ignore me\n");

		const callHostTool = vi.fn().mockResolvedValue({ output: "{}", status: "ok" });
		await recoverUncaptured({ host: { callHostTool }, stateDir, repoKey: "repo", worktreePath: "/repo" });

		const captured = callHostTool.mock.calls.map((c) => (c[1] as { sessionId: string }).sessionId).sort();
		expect(captured).toEqual(["s1-0", "s1-1"]);
		expect(callHostTool).toHaveBeenCalledWith("cortex__capture_session", {
			worktreePath: "/repo",
			sessionId: "s1-0",
			transcriptPath: join(dir, "s1-0.cortex.jsonl"),
			embed: true,
		});
	});

	it("is a no-op when the sessions dir is absent", async () => {
		const callHostTool = vi.fn();
		await recoverUncaptured({ host: { callHostTool }, stateDir: "/nonexistent-xyz", repoKey: "repo", worktreePath: "/repo" });
		expect(callHostTool).not.toHaveBeenCalled();
	});
});
