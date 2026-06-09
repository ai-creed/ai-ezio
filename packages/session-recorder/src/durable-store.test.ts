import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlDurableStore } from "./durable-store.js";
import type { RecordedTurn } from "./types.js";

describe("JsonlDurableStore", () => {
	it("appends one JSON line per turn including usage", () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-rec-"));
		const store = new JsonlDurableStore({ stateDir: dir, repoKey: "repo" });
		const ref = { sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" };
		const turn: RecordedTurn = {
			ref,
			index: 0,
			userText: "u",
			assistantText: "a",
			toolCalls: [{ name: "Read", input: "x", status: "ok" }],
			usage: { outputTokens: 5 },
		};
		store.append(turn);
		store.append({ ...turn, index: 1, usage: { outputTokens: 7 } });

		const file = join(dir, "sessions", "repo", "s1-0.record.jsonl");
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!);
		expect(first.usage).toEqual({ outputTokens: 5 });
		expect(first.toolCalls[0]).toEqual({ name: "Read", input: "x", status: "ok" });
		expect(JSON.parse(lines[1]!).usage).toEqual({ outputTokens: 7 });
	});
});
