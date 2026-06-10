import { describe, expect, it } from "vitest";
import { Compactor, type CompactorSession } from "./compactor.js";
import { COMPACTION_DEFAULTS, type CompactionConfig } from "./config.js";
import { CompactTimeoutError, type ExclusiveSession } from "./session.js";

interface FakeCalls {
	submits: string[];
	compacts: Array<{ summary: string; keep: number; drop: number }>;
}

/** Fake CompactorSession: records facet calls; behavior injectable. */
function fakeSession(opts?: {
	summarizeFails?: boolean;
	compactFails?: Error;
	/** Defer runExclusive bodies until released (for the in-gate re-check). */
	holdGate?: boolean;
}): { session: CompactorSession; calls: FakeCalls; releaseGate: () => void } {
	const calls: FakeCalls = { submits: [], compacts: [] };
	let release: () => void = () => {};
	const held = new Promise<void>((r) => (release = r));
	const facet: ExclusiveSession = {
		async submitAndWait(text) {
			calls.submits.push(text);
			if (opts?.summarizeFails) throw new Error("summarize boom");
			return { turnId: "t1", content: `SUMMARY(${text.slice(0, 9)})` };
		},
		async compact(summary, keep, drop) {
			calls.compacts.push({ summary, keep, drop });
			if (opts?.compactFails) throw opts.compactFails;
			return { droppedItems: 42, keptTurns: keep };
		},
	};
	const session: CompactorSession = {
		async runExclusive(fn) {
			if (opts?.holdGate) await held;
			return fn(facet);
		},
	};
	return { session, calls, releaseGate: release };
}

function cfg(overrides?: Partial<CompactionConfig>): CompactionConfig {
	return { ...COMPACTION_DEFAULTS, ...overrides };
}

describe("Compactor arming", () => {
	it("cycles at threshold, not below", async () => {
		const { session, calls } = fakeSession();
		const c = new Compactor({ session, config: cfg() });
		c.noteUsage({ contextTokens: 79, contextLimit: 100 });
		expect((await c.maybeAutoCompact()).kind).toBe("skipped");
		expect(calls.compacts).toHaveLength(0);
		c.noteUsage({ contextTokens: 80, contextLimit: 100 });
		expect((await c.maybeAutoCompact()).kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
	});

	it("unknown limit disarms auto; manual still works", async () => {
		const { session, calls } = fakeSession();
		const c = new Compactor({ session, config: cfg() });
		c.noteUsage({ contextTokens: 999999 }); // no contextLimit ever
		expect((await c.maybeAutoCompact()).kind).toBe("skipped");
		expect((await c.compactNow()).kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
	});

	it("auto: false disarms; manual still works", async () => {
		const { session, calls } = fakeSession();
		const c = new Compactor({ session, config: cfg({ auto: false }) });
		c.noteUsage({ contextTokens: 99, contextLimit: 100 });
		expect((await c.maybeAutoCompact()).kind).toBe("skipped");
		expect((await c.compactNow()).kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
	});

	it("re-checks arming AFTER acquiring the gate (spec §2)", async () => {
		const { session, calls, releaseGate } = fakeSession({ holdGate: true });
		const c = new Compactor({ session, config: cfg() });
		c.noteUsage({ contextTokens: 80, contextLimit: 100 });
		const pending = c.maybeAutoCompact(); // armed; parked at the gate
		c.noteUsage({ contextTokens: 30, contextLimit: 100 }); // a turn ran meanwhile
		releaseGate();
		expect(await pending).toEqual({ kind: "skipped", reason: "not-armed" });
		expect(calls.submits).toHaveLength(0);
		expect(calls.compacts).toHaveLength(0);
		// manual skips the threshold even below it
		expect((await c.compactNow()).kind).toBe("compacted");
	});
});

describe("Compactor cycle composition", () => {
	it("summary + rehydration block, keep from config, drop 1", async () => {
		const { session, calls } = fakeSession();
		const c = new Compactor({
			session,
			config: cfg({ keepLastTurns: 3 }),
			rehydrate: async () => "RULES-BLOCK",
		});
		const out = await c.compactNow();
		expect(out.kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
		const sent = calls.compacts[0];
		expect(sent.summary).toContain("[Context summary — session compacted]");
		expect(sent.summary).toContain("SUMMARY(");
		expect(sent.summary).toContain("[Carried-forward project memory]");
		expect(sent.summary).toContain("RULES-BLOCK");
		expect(sent.keep).toBe(3);
		expect(sent.drop).toBe(1); // the summarize exchange is excluded
	});

	it("rehydrate disabled by config or absent -> no memory block", async () => {
		for (const opts of [
			{ config: cfg({ rehydrate: false }), rehydrate: async () => "RULES" },
			{ config: cfg(), rehydrate: undefined },
		]) {
			const { session, calls } = fakeSession();
			const c = new Compactor({ session, ...opts });
			await c.compactNow();
			expect(calls.compacts[0].summary).not.toContain("[Carried-forward project memory]");
		}
	});

	it("rehydration block is truncated to 4000 chars", async () => {
		const { session, calls } = fakeSession();
		const c = new Compactor({ session, config: cfg(), rehydrate: async () => "x".repeat(9000) });
		await c.compactNow();
		const block = calls.compacts[0].summary.split("[Carried-forward project memory]")[1];
		expect(block.length).toBeLessThanOrEqual(4000 + 2); // + joining newlines
	});

	it("rehydrate failure never blocks compaction", async () => {
		const { session, calls } = fakeSession();
		const c = new Compactor({
			session,
			config: cfg(),
			rehydrate: async () => {
				throw new Error("cortex down");
			},
		});
		expect((await c.compactNow()).kind).toBe("compacted");
		expect(calls.compacts).toHaveLength(1);
	});
});

describe("Compactor failure handling", () => {
	it("summarize failure falls back to the digest, still drop 1", async () => {
		const { session, calls } = fakeSession({ summarizeFails: true });
		const c = new Compactor({
			session,
			config: cfg(),
			fallbackDigest: async () => "DIGEST-LINES",
		});
		const out = await c.compactNow();
		expect(out.kind).toBe("compacted");
		expect(calls.compacts[0].summary).toContain("DIGEST-LINES");
		expect(calls.compacts[0].drop).toBe(1); // the failed turn entered history
	});

	it("digest absent -> abort + re-arm rule (2% growth)", async () => {
		const { session, calls } = fakeSession({ summarizeFails: true });
		const notes: string[] = [];
		const c = new Compactor({ session, config: cfg(), onNote: (l) => notes.push(l) });
		c.noteUsage({ contextTokens: 80, contextLimit: 100 });
		expect((await c.maybeAutoCompact()).kind).toBe("failed");
		expect(notes[0]).toMatch(/no summary and no digest/);
		expect(calls.compacts).toHaveLength(0);
		// same fullness: re-arm floor blocks the retry
		expect((await c.maybeAutoCompact()).kind).toBe("skipped");
		// growth past failure-time + 2% of limit re-arms
		c.noteUsage({ contextTokens: 83, contextLimit: 100 });
		expect((await c.maybeAutoCompact()).kind).toBe("failed"); // cycles again
	});

	it("compact failure/timeout -> failed outcome, warning, re-arm, inProgress cleared", async () => {
		const { session } = fakeSession({ compactFails: new CompactTimeoutError(30000) });
		const notes: string[] = [];
		const c = new Compactor({ session, config: cfg(), onNote: (l) => notes.push(l) });
		c.noteUsage({ contextTokens: 80, contextLimit: 100 });
		const out = await c.maybeAutoCompact();
		expect(out.kind).toBe("failed");
		expect(notes.some((n) => n.includes("timed out"))).toBe(true);
		// re-arm floor blocks an identical-fullness auto retry
		expect((await c.maybeAutoCompact()).kind).toBe("skipped");
		// inProgress cleared: an immediate manual compact starts a fresh cycle
		const { session: ok } = fakeSession();
		const c2 = new Compactor({ session: ok, config: cfg() });
		expect((await c2.compactNow()).kind).toBe("compacted");
	});

	it("reentry: compactNow during a cycle reports in-progress", async () => {
		const { session, releaseGate } = fakeSession({ holdGate: true });
		const c = new Compactor({ session, config: cfg() });
		const first = c.compactNow(); // parked at the held gate
		expect(await c.compactNow()).toEqual({ kind: "skipped", reason: "in-progress" });
		releaseGate();
		expect((await first).kind).toBe("compacted");
	});
});
