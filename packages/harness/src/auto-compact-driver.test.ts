import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createAutoCompactDriver } from "./auto-compact-driver.js";
import { type CompactorSession } from "./compactor.js";
import { COMPACTION_DEFAULTS, type CompactionConfig } from "./config.js";
import { type ExclusiveSession } from "./session.js";

interface FakeCalls {
	submits: string[];
	compacts: Array<{ summary: string; keep: number; drop: number }>;
}

/** Fake CompactorSession mirroring compactor.test.ts; `holdSummarize` parks the
 * cycle mid-summarize so a test can observe `compacting()` while in flight. */
function fakeSession(opts?: { holdSummarize?: boolean }): {
	session: CompactorSession;
	calls: FakeCalls;
	releaseSummarize: () => void;
} {
	const calls: FakeCalls = { submits: [], compacts: [] };
	let release: () => void = () => {};
	const held = new Promise<void>((r) => (release = r));
	const facet: ExclusiveSession = {
		async submitAndWait(text) {
			calls.submits.push(text);
			if (opts?.holdSummarize) await held;
			return { turnId: "t1", content: `SUMMARY(${text.slice(0, 9)})` };
		},
		async compact(summary, keep, drop) {
			calls.compacts.push({ summary, keep, drop });
			return { droppedItems: 42, keptTurns: keep };
		},
	};
	const session: CompactorSession = {
		async runExclusive(fn) {
			return fn(facet);
		},
	};
	return { session, calls, releaseSummarize: release };
}

function cfg(overrides?: Partial<CompactionConfig>): CompactionConfig {
	return { ...COMPACTION_DEFAULTS, ...overrides };
}

const turnFinished = (contextTokens: number, contextLimit?: number): ProtocolEvent => ({
	type: "assistant_turn_finished",
	turnId: "t",
	content: "hi",
	usage: { contextTokens, ...(contextLimit !== undefined ? { contextLimit } : {}) },
});
const idle: ProtocolEvent = { type: "idle" };
/** Drain the microtask chain through a parked async point. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createAutoCompactDriver", () => {
	it("auto-compacts on idle once a finished turn pushes usage past the threshold", async () => {
		const { session, calls } = fakeSession();
		const driver = createAutoCompactDriver({ session, config: cfg() }); // threshold 0.8
		driver.handleEvent(turnFinished(80, 100)); // 80% — armed
		driver.handleEvent(idle);
		await driver.whenSettled();
		expect(calls.compacts).toHaveLength(1);
	});

	it("does not compact on idle when usage is below the threshold", async () => {
		const { session, calls } = fakeSession();
		const driver = createAutoCompactDriver({ session, config: cfg() });
		driver.handleEvent(turnFinished(79, 100)); // 79% — not armed
		driver.handleEvent(idle);
		await driver.whenSettled();
		expect(calls.compacts).toHaveLength(0);
	});

	it("only feeds usage from finished turns — other events never arm it", async () => {
		const { session, calls } = fakeSession();
		const driver = createAutoCompactDriver({ session, config: cfg() });
		driver.handleEvent({ type: "error", message: "boom" }); // not a usage source
		driver.handleEvent(idle);
		await driver.whenSettled();
		expect(calls.compacts).toHaveLength(0);
		expect(driver.compacting()).toBe(false);
	});

	it("reports compacting() true while a cycle runs and false once settled", async () => {
		const { session, releaseSummarize } = fakeSession({ holdSummarize: true });
		const driver = createAutoCompactDriver({ session, config: cfg() });
		driver.handleEvent(turnFinished(90, 100));
		expect(driver.compacting()).toBe(false);
		driver.handleEvent(idle); // fires the cycle; parks in the held summarize
		await tick();
		expect(driver.compacting()).toBe(true);
		releaseSummarize();
		await driver.whenSettled();
		expect(driver.compacting()).toBe(false);
	});

	it("compactNow() forces a cycle regardless of the threshold", async () => {
		const { session, calls } = fakeSession();
		const driver = createAutoCompactDriver({ session, config: cfg() });
		driver.handleEvent(turnFinished(10, 100)); // 10% — well below threshold
		expect((await driver.compactNow()).kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
	});

	it("exposes noteUsage + maybeAutoCompact for imperative consumers (standalone)", async () => {
		// The standalone CLI drives an await-loop, not an event stream: it feeds
		// usage and triggers the check directly, sharing this one driver with the
		// event-driven mounted adapter.
		const { session, calls } = fakeSession();
		const driver = createAutoCompactDriver({ session, config: cfg() });
		driver.noteUsage({ contextTokens: 79, contextLimit: 100 });
		expect((await driver.maybeAutoCompact()).kind).toBe("skipped"); // below threshold
		driver.noteUsage({ contextTokens: 80, contextLimit: 100 });
		expect((await driver.maybeAutoCompact()).kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
	});
});
