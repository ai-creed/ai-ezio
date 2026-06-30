import { describe, expect, it } from "vitest";
import type { RecordedTurn } from "@ai-ezio/session-recorder";
import {
	buildCompactor,
	callHostRehydration,
	digestFromRecorder,
	type RehydrationHost,
} from "./compaction-wiring.js";
import {
	COMPACTION_DEFAULTS,
	SUMMARIZE_INSTRUCTION,
	type ExclusiveSession,
} from "@ai-ezio/harness";

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
		timestamp: "",
		userText,
		assistantText: "a",
		toolCalls: tools.map((name) => ({ name, input: undefined, status: "ok" as const })),
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

	it("excludes the failed summarize attempt (spec §3 exclusion on the digest path)", () => {
		// The recorder finalizes the failed summarize turn (error drains to
		// idle) BEFORE the fallback digest is built — it must not re-import
		// the exchange that dropLastTurns: 1 just dropped from history.
		const d = digestFromRecorder({
			recentTurns: () => [turn("real work"), turn(SUMMARIZE_INSTRUCTION)],
		});
		expect(d).toContain("- real work");
		expect(d).not.toContain("dense continuation brief");
	});

	it("only summarize attempts recorded -> null (digest unavailable, abort path)", () => {
		expect(digestFromRecorder({ recentTurns: () => [turn(SUMMARIZE_INSTRUCTION)] })).toBeNull();
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

	it("digest fallback path excludes the failed summarize attempt end to end", async () => {
		const writes: string[] = [];
		const compactBlocks: string[] = [];
		const facet: ExclusiveSession = {
			submitAndWait: async () => {
				throw new Error("summarize boom");
			},
			compact: async (s, keep) => {
				compactBlocks.push(s);
				return { droppedItems: 1, keptTurns: keep };
			},
		};
		const wired = buildCompactor({
			session: { runExclusive: (fn) => fn(facet) } as never,
			config: { ...COMPACTION_DEFAULTS },
			// the recorder already finalized the failed summarize attempt
			digest: { recentTurns: () => [turn("real work"), turn(SUMMARIZE_INSTRUCTION)] },
			write: (s) => writes.push(s),
		});
		const out = await wired.compactor.compactNow();
		expect(out.kind).toBe("compacted");
		expect(compactBlocks[0]).toContain("- real work");
		expect(compactBlocks[0]).not.toContain("dense continuation brief");
	});
});
