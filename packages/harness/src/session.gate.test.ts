/**
 * M11 turn-gate contract: awaitable submit ordering, legacy
 * `submit(); waitForEvent("idle")` safety, onEvent transparency during a
 * cycle, facet escape, public compact(), serialized runExclusive, and the
 * compact-timeout containment strategy (stale swallow + waiter cancellation).
 * Driven against the scriptable fake engine (FAKE_COMPACT_MODE).
 */
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { CompactTimeoutError, Session, type ExclusiveSession } from "./session.js";

const FAKE = fileURLToPath(new URL("../test-fixtures/fake-engine.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

const PENDING = Symbol("pending");
/** True when `p` has not settled yet (microtask probe). */
async function isPending(p: Promise<unknown>): Promise<boolean> {
	const r = await Promise.race([p, Promise.resolve(PENDING)]);
	return r === PENDING;
}

/** Write a control without registering a waiter — the public stream is
 * single-consumer, so a concurrent status() would steal events from a wait
 * under test. */
function sendRaw(session: Session, control: object): void {
	(session as unknown as { control(c: object): void }).control(control);
}

/** Wait until the tee observed an event of `type` (the raw-control reply). */
async function waitTee(tee: ProtocolEvent[], type: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (tee.some((e) => e.type === type)) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`tee never saw ${type}`);
}

async function startSession(opts?: {
	compactTimeoutMs?: number;
	compactMode?: string;
	tee?: ProtocolEvent[];
}): Promise<Session> {
	const session = new Session({
		compactTimeoutMs: opts?.compactTimeoutMs,
		onEvent: opts?.tee ? (e) => opts.tee!.push(e) : undefined,
	});
	await session.start({
		binary: FAKE,
		env: {
			...process.env,
			FAKE_ENGINE_MODE: "ok",
			FAKE_COMPACT_MODE: opts?.compactMode ?? "ok",
		},
	});
	return session;
}

describe("Session turn gate (M11)", () => {
	it("public compact() resolves the compacted result and consumes the idle", async () => {
		const session = await startSession();
		const res = await session.compact("SUM", 2, 1);
		expect(res).toEqual({ droppedItems: 101, keptTurns: 2 });
		// stream settled at a boundary: a normal turn still works
		const turn = await session.submitAndWait("after");
		expect(turn.content).toBe("ok after");
		session.close();
	}, 10000);

	it("a submit issued during a cycle is deferred until after compact lands", async () => {
		const tee: ProtocolEvent[] = [];
		const session = await startSession({ tee });
		let submitResolved = false;

		const cycle = session.runExclusive(async (s) => {
			await s.submitAndWait("summarize");
			// the concurrent submit must still be parked at the gate
			expect(submitResolved).toBe(false);
			return s.compact("SUM", 2, 1);
		});
		const queued = session.submit("next").then(() => {
			submitResolved = true;
		});
		await cycle;
		await queued;
		expect(submitResolved).toBe(true);
		await session.waitForEvent("idle"); // the queued turn completes

		const types = tee.map((e) => e.type);
		const compactedAt = types.indexOf("compacted");
		// the queued turn's user_turn_started comes strictly after compacted
		const queuedTurnAt = types.lastIndexOf("user_turn_started");
		expect(compactedAt).toBeGreaterThan(-1);
		expect(queuedTurnAt).toBeGreaterThan(compactedAt);
		session.close();
	}, 10000);

	it("legacy pattern: an outside idle-waiter never resolves on cycle-internal idles", async () => {
		const tee: ProtocolEvent[] = [];
		const session = await startSession({ tee });

		let waiter: Promise<ProtocolEvent> | undefined;
		const cycle = session.runExclusive(async (s) => {
			// register the legacy pattern MID-CYCLE: unawaited submit + bare wait
			void session.submit("next");
			waiter = session.waitForEvent("idle");
			await s.submitAndWait("summarize"); // produces a cycle-internal idle
			const r = await s.compact("SUM", 2, 1); // produces another idle
			// both cycle idles have been emitted; the outside waiter must still
			// be pending (events were routed to the exclusive stream)
			expect(await isPending(waiter)).toBe(true);
			return r;
		});
		await cycle;
		await waiter; // resolves on the queued turn's OWN idle, post-cycle
		const types = tee.map((e) => e.type);
		expect(types.filter((t) => t === "idle").length).toBeGreaterThanOrEqual(3);
		session.close();
	}, 10000);

	it("onEvent tee observes every cycle-internal event", async () => {
		const tee: ProtocolEvent[] = [];
		const session = await startSession({ tee });
		await session.runExclusive(async (s) => {
			await s.submitAndWait("summarize");
			return s.compact("SUM", 1, 0);
		});
		const types = tee.map((e) => e.type);
		expect(types).toContain("assistant_turn_finished");
		expect(types).toContain("compacted");
		expect(types.filter((t) => t === "idle").length).toBe(2);
		session.close();
	}, 10000);

	it("the facet throws once its critical section settled", async () => {
		const session = await startSession();
		let escaped: ExclusiveSession | undefined;
		await session.runExclusive(async (s) => {
			escaped = s;
			return undefined;
		});
		expect(() => escaped!.submitAndWait("x")).toThrow(/critical section/);
		expect(() => escaped!.compact("S", 1, 0)).toThrow(/critical section/);
		session.close();
	}, 10000);

	it("two runExclusive calls serialize", async () => {
		const session = await startSession();
		const log: string[] = [];
		const first = session.runExclusive(async (s) => {
			log.push("first:start");
			await s.submitAndWait("one");
			log.push("first:end");
		});
		const second = session.runExclusive(async () => {
			log.push("second:start");
		});
		await Promise.all([first, second]);
		expect(log).toEqual(["first:start", "first:end", "second:start"]);
		session.close();
	}, 10000);
});

describe("Session compact timeout containment (M11)", () => {
	it("(a) rejects CompactTimeoutError and releases the gate", async () => {
		const session = await startSession({ compactTimeoutMs: 60, compactMode: "hold" });
		await expect(session.compact("SUM", 2, 0)).rejects.toBeInstanceOf(CompactTimeoutError);
		// gate released: a normal gated turn completes
		const turn = await session.submitAndWait("alive");
		expect(turn.content).toBe("ok alive");
		session.close();
	}, 10000);

	it("(b) the stale pair is swallowed: an outside idle-waiter ignores it; the tee sees it", async () => {
		const tee: ProtocolEvent[] = [];
		const session = await startSession({ compactTimeoutMs: 60, compactMode: "hold", tee });
		await expect(session.compact("SUM", 2, 0)).rejects.toBeInstanceOf(CompactTimeoutError);

		const waiter = session.waitForEvent("idle");
		// flush the stale pair (hold mode: a status control flushes parked
		// replies first); raw write — a competing status() waiter would steal
		// from the wait under test (public stream is single-consumer).
		sendRaw(session, { type: "status" });
		await waitTee(tee, "status");
		// the tee observed the stale pair...
		expect(tee.map((e) => e.type)).toContain("compacted");
		// ...but the outside idle-waiter did NOT resolve on the stale idle
		expect(await isPending(waiter)).toBe(true);
		// a real turn's idle resolves it (submit is fire-and-forget; the waiter
		// consumes the turn's events including its idle)
		void session.submit("real");
		await waiter;
		session.close();
	}, 10000);

	it("(c) a retry compact is not confused by the stale pair (FIFO swallow)", async () => {
		const session = await startSession({ compactTimeoutMs: 60, compactMode: "hold" });
		await expect(session.compact("A", 2, 0)).rejects.toBeInstanceOf(CompactTimeoutError);

		// retry (parked too), then a raw status control triggers the FIFO
		// flush: pair #1 (stale, swallowed) then pair #2 (the retry's answer).
		// compact() writes its control after a gate-acquire microtask, so give
		// it one tick before the flush trigger or status would overtake it on
		// the control fd and pair #2 would never be flushed.
		const retry = session.compact("B", 3, 0);
		await new Promise((r) => setTimeout(r, 10));
		sendRaw(session, { type: "status" });
		const res = await retry;
		expect(res).toEqual({ droppedItems: 102, keptTurns: 3 }); // the SECOND pair
		session.close();
	}, 10000);

	it("(d) partial timeout (compacted seen, idle missing) swallows only the next idle", async () => {
		const tee: ProtocolEvent[] = [];
		const session = await startSession({ compactTimeoutMs: 60, compactMode: "hold-idle", tee });
		// compacted arrives immediately; its idle is parked -> timeout on idle
		await expect(session.compact("SUM", 2, 0)).rejects.toBeInstanceOf(CompactTimeoutError);

		const waiter = session.waitForEvent("idle");
		sendRaw(session, { type: "status" }); // flushes the stale idle (swallowed)
		await waitTee(tee, "status");
		expect(await isPending(waiter)).toBe(true);
		void session.submit("real");
		await waiter; // resolves on the real turn's idle, not the stale one
		session.close();
	}, 10000);

	it("(e) no orphaned waiter on the public stream after a public compact timeout", async () => {
		const session = await startSession({ compactTimeoutMs: 60, compactMode: "hold" });
		await expect(session.compact("SUM", 2, 0)).rejects.toBeInstanceOf(CompactTimeoutError);
		// the abandoned wait deregistered itself
		expect((session as unknown as { waiters: unknown[] }).waiters).toHaveLength(0);
		// an unrelated event is delivered to a fresh waiter, not stolen:
		// status() registers its own waiter and receives the status event
		// (the stale pair parked before it is swallowed on flush).
		const status = await session.status();
		expect(status.model).toBe("fake-model");
		session.close();
	}, 10000);
});
