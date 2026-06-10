import { describe, expect, it } from "vitest";
import type { RecordedTurn } from "@ai-ezio/session-recorder";
import {
	buildCompactor,
	callHostRehydration,
	digestFromRecorder,
	type RehydrationHost,
} from "./compaction-wiring.js";
import { COMPACTION_DEFAULTS, type ExclusiveSession } from "@ai-ezio/harness";

function fakeHost(opts: {
	names: string[];
	output?: string;
	status?: "ok" | "error";
	throws?: boolean;
}): { host: RehydrationHost; calls: Array<{ name: string; args: unknown }> } {
	const calls: Array<{ name: string; args: unknown }> = [];
	return {
		calls,
		host: {
			hostToolNames: () => opts.names,
			callHostTool: async (name, args) => {
				calls.push({ name, args });
				if (opts.throws) throw new Error("down");
				return { output: opts.output ?? "", status: opts.status ?? "ok" };
			},
		},
	};
}

function turn(userText: string, tools: string[] = []): RecordedTurn {
	return {
		ref: { sessionId: "s", conversationId: "c", worktreePath: "/r" },
		index: 0,
		userText,
		assistantText: "a",
		toolCalls: tools.map((name) => ({ name, status: "ok" as const })),
	};
}

describe("callHostRehydration", () => {
	it("picks the rehydration tool, passes {}, returns the ok output", async () => {
		const { host, calls } = fakeHost({
			names: ["cortex__rehydrate_project", "cortex__get_memory"],
			output: "RULES",
		});
		expect(await callHostRehydration(host)).toBe("RULES");
		expect(calls).toEqual([{ name: "cortex__rehydrate_project", args: {} }]);
	});

	it("error status, empty output, no match, or a throw -> null", async () => {
		expect(
			await callHostRehydration(
				fakeHost({ names: ["cortex__recall_memory"], output: "x", status: "error" }).host,
			),
		).toBeNull();
		expect(
			await callHostRehydration(fakeHost({ names: ["cortex__recall_memory"], output: "  " }).host),
		).toBeNull();
		const none = fakeHost({ names: ["cortex__capture_session"] });
		expect(await callHostRehydration(none.host)).toBeNull();
		expect(none.calls).toHaveLength(0);
		expect(
			await callHostRehydration(fakeHost({ names: ["cortex__recall_memory"], throws: true }).host),
		).toBeNull();
	});
});

describe("digestFromRecorder", () => {
	it("builds bounded lines with tool names; null when empty", () => {
		expect(digestFromRecorder({ recentTurns: () => [] })).toBeNull();
		const d = digestFromRecorder({
			recentTurns: () => [turn("fix the parser\nplease", ["bash", "read"]), turn("run tests")],
		});
		expect(d).toContain("Deterministic digest");
		expect(d).toContain("- fix the parser please [tools: bash,read]");
		expect(d).toContain("- run tests");
	});
});

describe("buildCompactor", () => {
	it("wraps a cycle with compacting chrome and a suppression span", async () => {
		const writes: string[] = [];
		const facet: ExclusiveSession = {
			submitAndWait: async () => ({ turnId: "t", content: "SUMMARY" }),
			compact: async (_s, keep) => ({ droppedItems: 9, keptTurns: keep }),
		};
		const wired = buildCompactor({
			session: { runExclusive: (fn) => fn(facet) } as never,
			config: { ...COMPACTION_DEFAULTS },
			write: (s) => writes.push(s),
		});
		expect(wired.compacting()).toBe(false);
		const out = await wired.compactor.compactNow();
		expect(out.kind).toBe("compacted");
		expect(wired.compacting()).toBe(false); // span closed by the outcome note
		expect(writes[0]).toContain("compacting…");
		expect(writes[1]).toContain("✦ compacted — dropped 9 items");
	});
});
