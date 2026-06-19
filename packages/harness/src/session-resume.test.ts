import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { PROTOCOL_VERSION, type ProtocolEvent, type Transport } from "@ai-ezio/protocol";
import { EngineBusyError, Session } from "./session.js";
import { createRenameController } from "./session-titles.js";
import { resolveHaxBinary } from "./resolve-hax.js";

/** Drain microtasks + one macrotask so a pending async step (e.g. resume()'s
 * gate.acquire → generation bump → `await dying`) reaches its next suspension. */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** A hand-driven fake transport: tests push events and signal EOF explicitly. */
function fakeTransport() {
	let push!: (e: ProtocolEvent) => void;
	let end!: () => void;
	const events = (async function* (): AsyncGenerator<ProtocolEvent> {
		const buf: ProtocolEvent[] = [];
		let done = false;
		let wake: (() => void) | null = null;
		push = (e) => {
			buf.push(e);
			wake?.();
		};
		end = () => {
			done = true;
			wake?.();
		};
		for (;;) {
			if (buf.length) {
				yield buf.shift()!;
				continue;
			}
			if (done) return;
			await new Promise<void>((r) => (wake = r));
		}
	})();
	const sent: ProtocolEvent[] = [];
	// Transport requires close(): void (packages/protocol/src/transport.ts) — a no-op
	// here; the fake child kill is also a no-op, so the OLD pump only ends when a test
	// calls end() (which is exactly how the stale-EOF ordering is driven below).
	const t: Transport = {
		events: () => events,
		send: (c) => void sent.push(c as ProtocolEvent),
		close: () => {},
	};
	return { transport: t, push: (e: ProtocolEvent) => push(e), end: () => end(), sent };
}

// IMPORTANT: `ready` MUST carry the harness's own PROTOCOL_VERSION, or start()/resume()
// reject with ProtocolVersionError (isProtocolCompatible compares the major) before the
// test can exercise anything. A literal "1" would fail against a "0.x" harness.
const ready = (sessionId = "s") =>
	({
		type: "ready",
		sessionId,
		protocol: PROTOCOL_VERSION,
		haxBaseCommit: "c",
	}) as unknown as ProtocolEvent;
const readyResumed = (id: string) => ready(id);
const statusEvent = (sessionId: string) =>
	({
		type: "status",
		sessionId,
		model: "m",
		provider: "p",
		protocol: PROTOCOL_VERSION,
		state: "idle",
	}) as unknown as ProtocolEvent;

describe("Session.resume", () => {
	function makeSession(transports: ReturnType<typeof fakeTransport>[]) {
		let i = 0;
		const session = new Session({
			spawn: () => ({
				child: { on: () => {}, kill: () => {} } as never,
				eventStream: new PassThrough(),
				controlStream: new PassThrough(),
			}),
			transportFactory: () => transports[i++]!.transport,
		});
		return session;
	}

	it("rejects while a turn holds the gate", async () => {
		const t1 = fakeTransport();
		const session = makeSession([t1]);
		const started = session.start();
		t1.push(ready());
		await started;
		const release = await (
			session as unknown as { gate: { acquire(): Promise<() => void> } }
		).gate.acquire();
		// Recoverable (NOT a respawn failure): a distinct EngineBusyError so callers
		// report "busy" and leave the session intact rather than tearing it down.
		const err = await session.resume("other").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(EngineBusyError);
		expect((err as Error).name).toBe("EngineBusyError");
		expect((err as Error).message).toMatch(/turn is in flight/);
		release();
	});

	it("a stale old-pump event + EOF cannot corrupt the respawned session", async () => {
		const t1 = fakeTransport();
		const t2 = fakeTransport();
		const session = makeSession([t1, t2]);
		const started = session.start();
		t1.push(ready());
		await started;

		const resumed = session.resume("resumed-id");
		// Let resume() acquire the gate, bump generation, close(), and PARK at
		// `await this.pumpDone`. The fake child kill is a no-op, so the OLD pump only
		// ends when we call t1.end() — which is how we control the stale-EOF ordering.
		await flush();
		t1.push({ type: "idle" } as unknown as ProtocolEvent); // OLD generation now → dropped by the gen guard
		t1.end(); // OLD EOF → its finally runs under the old gen → no-op (no ended, no waiter drain)
		await flush(); // resume() unwinds the old pump, resets latches, spawns t2, awaits its ready
		t2.push(readyResumed("resumed-id")); // the NEW generation's ready
		const r = await resumed;

		expect(r.sessionId).toBe("resumed-id");
		expect((session as unknown as { ended: boolean }).ended).toBe(false);
		// The resumed session is live: a status round-trip settles on the NEW transport.
		const statusP = session.status();
		await flush();
		t2.push(statusEvent("resumed-id"));
		expect((await statusP).sessionId).toBe("resumed-id");
	});
});

describe("RenameController over a real Session (§1C, no idle theft)", () => {
	it("the deferred first-turn status refresh does not consume the turn's idle", async () => {
		const t = fakeTransport();
		const titled: string[] = [];
		let session!: Session;
		const rename = createRenameController({
			store: { getTitle: () => undefined, setTitle: (id) => void titled.push(id) },
			// The runtime defers the status() off the delivery turn (queueMicrotask).
			requestStatus: () => queueMicrotask(() => void session.status().catch(() => {})),
		});
		session = new Session({
			spawn: () => ({
				child: { on: () => {}, kill: () => {} } as never,
				eventStream: new PassThrough(),
				controlStream: new PassThrough(),
			}),
			transportFactory: () => t.transport,
			onEvent: (e) => rename.noteEvent(e),
		});
		const started = session.start();
		t.push(ready("unknown")); // fresh session: id not materialized
		await started;
		expect(rename.currentSessionId()).toBeUndefined();

		// Run a turn; the settling idle must reach submitAndWait, not the status()
		// the controller schedules on that same idle.
		const turn = session.submitAndWait("hi");
		await flush();
		t.push({
			type: "assistant_turn_finished",
			turnId: "t1",
			content: "answer",
		} as unknown as ProtocolEvent);
		t.push({ type: "idle" } as unknown as ProtocolEvent);
		const result = await turn; // would hang if the idle were stolen
		expect(result.content).toBe("answer");

		// The deferred status() round-trips; its status event materializes the id.
		await flush();
		t.push(statusEvent("uuid-real"));
		await flush();
		expect(rename.currentSessionId()).toBe("uuid-real");
		expect(titled).toEqual([]); // no pending title in this test → nothing written
	});
});

const haxBuilt = existsSync(new URL("../../../vendor/hax/build/hax", import.meta.url));

/** Parse `hax --list-sessions` for the current cwd (the test's storage scope). */
function listSessions(
	env: NodeJS.ProcessEnv,
): Promise<Array<{ id: string; firstPrompt: string | null }>> {
	return new Promise((resolve) => {
		let out = "";
		const c = spawn(resolveHaxBinary(), ["--list-sessions"], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "ignore"],
		});
		c.stdout?.on("data", (d: Buffer) => void (out += d.toString("utf8")));
		c.on("error", () => resolve([]));
		c.on("exit", () => {
			try {
				resolve(JSON.parse(out));
			} catch {
				resolve([]);
			}
		});
	});
}

describe.runIf(haxBuilt)("Session.resume (real hax, mock provider)", () => {
	it("replays seeded history, accepts post-resume turns, and resets latches across repeated resumes", async () => {
		const env = { ...process.env, HAX_PROVIDER: "mock" };

		// 1. Seed a session: one turn so hax materializes the session file + id.
		const a = new Session();
		await a.start({ env });
		await a.submitAndWait("SEED ALPHA remember this");
		const id = (await a.status()).sessionId;
		expect(id).not.toBe("unknown");
		a.close();
		const seeded = (await listSessions(env)).find((r) => r.id === id);
		expect(seeded?.firstPrompt).toContain("SEED ALPHA"); // the seed is the session's first prompt

		// 2. Resume it in a NEW Session object.
		const b = new Session();
		await b.start({ env });
		const ready1 = await b.resume(id, { env });
		expect(ready1.sessionId).toBe(id); // continuation, not a fresh session

		// 3. Post-resume turn works; history replayed = SAME log reused (id + original
		//    firstPrompt preserved, exactly one row — no fork), not a new session.
		const turn1 = await b.submitAndWait("FOLLOW ONE");
		expect(typeof turn1.content).toBe("string");
		expect((await b.status()).sessionId).toBe(id);
		const afterResume = await listSessions(env);
		expect(afterResume.filter((r) => r.id === id).length).toBe(1);
		expect(afterResume.find((r) => r.id === id)?.firstPrompt).toContain("SEED ALPHA");

		// 4. Latch reset: a SECOND resume on the SAME Session object succeeds.
		const ready2 = await b.resume(id, { env });
		expect(ready2.sessionId).toBe(id);
		const turn2 = await b.submitAndWait("FOLLOW TWO");
		expect(typeof turn2.content).toBe("string");
		expect((await b.status()).sessionId).toBe(id);
		b.close();
	});
});
