import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCortexLines } from "./cortex-projection.js";
import type { RecordedTurn } from "./types.js";

const ref = { sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" };

describe("renderCortexLines", () => {
	it("emits a user line then an assistant line with text + tool_use blocks", () => {
		const turn: RecordedTurn = {
			ref,
			index: 0,
			timestamp: "",
			userText: "look at foo.ts",
			assistantText: "Reading it.",
			toolCalls: [
				{ name: "Read", input: { file_path: "src/foo.ts" }, status: "ok" },
				{ name: "bash", input: "grep -n TODO", status: "ok" },
			],
		};
		const [userLine, asstLine] = renderCortexLines(turn, 0).map((l) => JSON.parse(l));

		expect(userLine).toEqual({
			type: "user",
			turn: 0,
			message: { content: [{ type: "text", text: "look at foo.ts" }] },
		});
		expect(asstLine.type).toBe("assistant");
		expect(asstLine.turn).toBe(1);
		expect(asstLine.message.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(asstLine.message.content[1]).toEqual({
			type: "tool_use",
			name: "Read",
			input: { file_path: "src/foo.ts" },
		});
		expect(asstLine.message.content[2]).toEqual({
			type: "tool_use",
			name: "bash",
			input: "grep -n TODO",
		});
	});

	it("uses the running line counter so turn numbers stay monotonic", () => {
		const turn: RecordedTurn = { ref, index: 3, timestamp: "", userText: "u", assistantText: "a", toolCalls: [] };
		const [u, a] = renderCortexLines(turn, 6).map((l) => JSON.parse(l));
		expect(u.turn).toBe(6);
		expect(a.turn).toBe(7);
	});

	it("omits tool_use input gracefully when undefined", () => {
		const turn: RecordedTurn = {
			ref,
			index: 0,
			timestamp: "",
			userText: "u",
			assistantText: "a",
			toolCalls: [{ name: "noop", input: undefined, status: "ok" }],
		};
		const a = JSON.parse(renderCortexLines(turn, 0)[1]);
		expect(a.message.content[1]).toEqual({ type: "tool_use", name: "noop", input: {} });
	});
});

// Real round-trip through cortex's parser+evidence (spec §6). Runs only when the sibling
// ai-cortex build is present; set AI_CORTEX_DIST to its `dist` root to enable it locally
// and in the workflow. Skipped (not failed) otherwise so ezio CI stays decoupled from cortex.
const cortexDist = process.env.AI_CORTEX_DIST;
const compactPath = cortexDist ? join(cortexDist, "lib/history/compact.js") : "";
describe.skipIf(!cortexDist || !existsSync(compactPath))(
	"renderCortexLines × cortex real parser",
	() => {
		it("yields user prompts, tool calls, and file paths via cortex's parseTranscript+extractEvidence", async () => {
			const { parseTranscript, extractEvidence } = (await import(compactPath)) as {
				parseTranscript: (p: string) => unknown[];
				extractEvidence: (t: unknown[]) => {
					userPrompts: { text: string }[];
					toolCalls: { name: string }[];
					filePaths: { path: string }[];
				};
			};
			const turn: RecordedTurn = {
				ref,
				index: 0,
				timestamp: "",
				userText: "analyze the auth module",
				assistantText: "reading",
				toolCalls: [{ name: "Read", input: { file_path: "src/auth.ts" }, status: "ok" }],
			};
			const dir = mkdtempSync(join(tmpdir(), "ezio-rt-"));
			const file = join(dir, "t.jsonl");
			writeFileSync(file, `${renderCortexLines(turn, 0).join("\n")}\n`);
			const ev = extractEvidence(parseTranscript(file));
			expect(ev.userPrompts.map((u) => u.text)).toContain("analyze the auth module");
			expect(ev.toolCalls.map((t) => t.name)).toContain("Read");
			expect(ev.filePaths.map((f) => f.path)).toContain("src/auth.ts");
		});
	},
);
