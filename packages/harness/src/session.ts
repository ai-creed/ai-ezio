/**
 * Session: drives one hax engine over the protocol. Owns the child + transport,
 * applies the `ready` version gate, and exposes the turn lifecycle as a typed
 * API. `idle` is treated as the only safe point to issue the next `submit`.
 */
import {
	FdTransport,
	isProtocolCompatible,
	PROTOCOL_VERSION,
	type DelegatedToolDef,
	type ProtocolControl,
	type ProtocolEvent,
	type ReadyEvent,
	type StatusEvent,
	type Transport,
} from "@ai-ezio/protocol";
import type { Readable, Writable } from "node:stream";
import { spawnHax, type SpawnedHax, type SpawnHaxOptions } from "./spawn.js";
import { TurnGate } from "./turn-gate.js";

export class ProtocolVersionError extends Error {
	constructor(theirs: string, ours: string) {
		super(`unsupported engine protocol ${theirs} (harness speaks ${ours})`);
		this.name = "ProtocolVersionError";
	}
}

/** A turn-scoped, recoverable error: the engine reported `error` during a turn
 * but returned to `idle`, so the session remains usable for further submits. */
export class TurnError extends Error {
	constructor(
		message: string,
		public readonly turnId?: string,
	) {
		super(message);
		this.name = "TurnError";
	}
}

/** A fatal session failure: fd 3 reached EOF (the engine exited). Authoritative —
 * no further submits are valid after this. */
export class EngineExitedError extends Error {
	constructor(message = "engine exited (fd-3 EOF)") {
		super(message);
		this.name = "EngineExitedError";
	}
}

/** A completed user turn. */
export interface TurnResult {
	turnId: string;
	/** Authoritative handback (assistant_turn_finished.content). */
	content: string;
}

/** Result of a `compact` control (M11). */
export interface CompactResult {
	droppedItems: number;
	keptTurns: number;
}

/** The engine never produced `compacted` (or its paired `idle`) within the
 * deadline (spec §3: "compact control fails or times out" — abort the cycle,
 * session untouched by atomicity, caller surfaces a warning and applies the
 * re-arm rule). */
export class CompactTimeoutError extends Error {
	constructor(ms: number) {
		super(`compact control timed out after ${ms}ms (no compacted event)`);
		this.name = "CompactTimeoutError";
	}
}

/** Unlocked operations available inside Session.runExclusive (M11). The facet
 * throws once its critical section has settled. */
export interface ExclusiveSession {
	submitAndWait(text: string): Promise<TurnResult>;
	compact(summary: string, keepLastTurns: number, dropLastTurns: number): Promise<CompactResult>;
}

export interface SessionOptions {
	/** Observer (tee) called for every event, in order, before consumption.
	 * Non-consuming — useful for recording the full sequence in tests/loggers. */
	onEvent?: (event: ProtocolEvent) => void;
	/** Deadline for a `compact` control to produce `compacted` + `idle`
	 * (default 30_000ms). Injectable so tests use a tiny value. */
	compactTimeoutMs?: number;
	/** Test seam: spawn the engine child (defaults to spawnHax). */
	spawn?: (options: SpawnHaxOptions) => SpawnedHax;
	/** Test seam: build the transport from the child's fd streams (defaults to FdTransport). */
	transportFactory?: (events: Readable, controls: Writable) => Transport;
}

export class Session {
	private spawned?: SpawnedHax;
	private transport?: Transport;
	private readonly queue: ProtocolEvent[] = [];
	private readonly waiters: Array<(e: ProtocolEvent | null) => void> = [];
	private ended = false;
	private closed = false;
	private readonly exitHandlers: Array<
		(info: { code: number | null; signal: NodeJS.Signals | null }) => void
	> = [];
	ready?: ReadyEvent;

	/** Bumped on every spawn (start + resume). The pump closure captures its own
	 * generation; a stale generation's events and EOF are dropped, so a closed
	 * child cannot corrupt a freshly-respawned session. */
	private generation = 0;
	/** Resolves when the CURRENT pump's `for await` loop has fully unwound
	 * (its `finally` ran). `resume()` awaits this to sequence teardown. */
	private pumpDone: Promise<void> = Promise.resolve();

	private _transcriptPath?: string;
	/** The `HAX_TRANSCRIPT` mirror path this session was started with, if any.
	 * Consumers (ezio CLI, ai-whisper) read it here rather than re-deriving the
	 * env contract. Set synchronously in start(), before the engine spawns. */
	get transcriptPath(): string | undefined {
		return this._transcriptPath;
	}

	constructor(private readonly options: SessionOptions = {}) {}

	/** Subscribe to engine child-exit (workflow-agnostic lifecycle signal for
	 * adapters that surface provider exit). Fires once per child exit. */
	onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
		this.exitHandlers.push(handler);
	}

	private readonly gate = new TurnGate();
	/** True while a runExclusive body runs: events route to the exclusive
	 * stream and the public stream is paused (cycle-internal idles can never
	 * resolve outside waiters; onEvent still sees everything). */
	private cycleInternal = false;
	private readonly exclusiveQueue: ProtocolEvent[] = [];
	private readonly exclusiveWaiters: Array<(e: ProtocolEvent | null) => void> = [];
	/** Timed-out compacts whose late `compacted` (+ paired idle) must be
	 * swallowed from EVERY consumer stream. Controls are processed in arrival
	 * order, so a count is FIFO-correct: the next N `compacted` events on the
	 * wire belong to abandoned controls, never to a newer one. */
	private staleCompactsPending = 0;
	private swallowNextIdle = false;
	/** Gate releases parked until the next REAL idle (non-consuming, fired at
	 * the delivery layer). A bare submit() must hold the gate until its turn
	 * settles — releasing at control-write would let a compaction cycle start
	 * mid-turn, flip cycleInternal, and steal the in-flight turn's events as
	 * the cycle's own (the facet would consume the user's reply as the
	 * "summary" and the user's bare idle-waiter would starve). */
	private readonly idleHooks: Array<() => void> = [];

	private deliver(event: ProtocolEvent | null): void {
		if (event && this.options.onEvent) this.options.onEvent(event);
		if (event === null) {
			// fatal EOF: release parked gate holds (a dead engine emits no
			// idle — without this, every later turn initiator would deadlock),
			// then flush BOTH waiter sets.
			while (this.idleHooks.length) this.idleHooks.shift()!();
			while (this.exclusiveWaiters.length) this.exclusiveWaiters.shift()!(null);
			const w = this.waiters.shift();
			if (w) w(null);
			return;
		}
		// Stale-compact swallow (timeout aftermath, spec §3 + the suppression
		// contract): a timed-out compact's late `compacted` and its paired
		// `idle` must reach NO consumer stream — a public waiter must not
		// resolve on them, and a retry cycle's exclusive waits must not
		// mistake them for its own replies. Checked BEFORE any routing; the
		// onEvent tee (above) still observes everything.
		if (event.type === "compacted" && this.staleCompactsPending > 0) {
			this.staleCompactsPending--;
			this.swallowNextIdle = true;
			return;
		}
		if (event.type === "idle" && this.swallowNextIdle) {
			this.swallowNextIdle = false;
			return;
		}
		// A REAL idle (post-swallow) settles any bare submit holding the gate.
		// Non-consuming: the event still routes below; hooks can never be
		// pending during a cycle (the held gate is what excludes cycles).
		if (event.type === "idle" && this.idleHooks.length) {
			for (const h of this.idleHooks.splice(0)) h();
		}
		if (this.cycleInternal) {
			const w = this.exclusiveWaiters.shift();
			if (w) w(event);
			else this.exclusiveQueue.push(event);
			return;
		}
		const w = this.waiters.shift();
		if (w) w(event);
		else this.queue.push(event);
	}

	private next(): Promise<ProtocolEvent | null> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.ended) return Promise.resolve(null);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Event source for unlocked internals: exclusive stream during a cycle,
	 * public stream otherwise. With `ms` set, the wait carries a deadline that
	 * DEREGISTERS its own pending waiter before rejecting — an abandoned wait
	 * must never remain registered, or it would steal the next legitimate
	 * event from a later caller (the orphaned-waiter leak). This holds for
	 * BOTH streams: a public `session.compact()` timeout deregisters from the
	 * public `waiters` array the same way. */
	private nextEventWithin(ms?: number): Promise<ProtocolEvent | null> {
		const queue = this.cycleInternal ? this.exclusiveQueue : this.queue;
		const waiters = this.cycleInternal ? this.exclusiveWaiters : this.waiters;
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.ended) return Promise.resolve(null);
		if (ms === undefined) return new Promise((resolve) => waiters.push(resolve));
		// Deadline path (today only compact uses it): one timer per wait, owned
		// by the wait, cleared on delivery, deregistering on expiry.
		return new Promise((resolve, reject) => {
			const waiter = (e: ProtocolEvent | null): void => {
				clearTimeout(timer);
				resolve(e);
			};
			const timer = setTimeout(() => {
				const i = waiters.indexOf(waiter);
				if (i >= 0) waiters.splice(i, 1); // cancel: no orphan steals later events
				reject(new CompactTimeoutError(ms));
			}, ms);
			timer.unref?.();
			waiters.push(waiter);
		});
	}

	/** Consume events until one of the given type arrives. Fatal EOF →
	 * EngineExitedError; a turn-scoped `error` → TurnError. */
	async waitForEvent(type: ProtocolEvent["type"]): Promise<ProtocolEvent> {
		for (;;) {
			const e = await this.next();
			if (e === null) throw new EngineExitedError(`engine exited before "${type}"`);
			if (e.type === "error" && type !== "error") {
				throw new TurnError(e.message, e.turnId);
			}
			if (e.type === type) return e;
		}
	}

	/** Spawn hax, pump events, and gate on the `ready` protocol version. */
	async start(options: SpawnHaxOptions = {}): Promise<ReadyEvent> {
		return this.spawnAndPump(options);
	}

	/** Spawn the child, launch the (generation-stamped) event pump, and resolve
	 * the `ready` version gate. Shared by start() and resume() so the pump is
	 * stamped in exactly one place. Captures the CURRENT generation — callers that
	 * need a fresh generation (resume) bump it before calling. */
	private async spawnAndPump(options: SpawnHaxOptions): Promise<ReadyEvent> {
		this._transcriptPath = options.transcriptPath;
		const gen = this.generation;
		const spawned = (this.options.spawn ?? spawnHax)(options);
		this.spawned = spawned;
		spawned.child.on("exit", (code, signal) => {
			if (gen !== this.generation) return; // stale child exit: never cascade
			for (const handler of this.exitHandlers) handler({ code, signal });
		});
		const transport = (this.options.transportFactory ?? ((e, c) => new FdTransport(e, c)))(
			spawned.eventStream,
			spawned.controlStream,
		);
		this.transport = transport;
		this.pumpDone = (async () => {
			try {
				for await (const event of transport.events()) {
					if (gen !== this.generation) continue; // stale generation: drop
					this.deliver(event);
				}
			} finally {
				if (gen === this.generation) {
					this.ended = true;
					while (this.idleHooks.length) this.idleHooks.shift()!();
					while (this.waiters.length || this.exclusiveWaiters.length) this.deliver(null);
				}
			}
		})();
		const ready = (await this.waitForEvent("ready")) as ReadyEvent;
		if (!isProtocolCompatible(ready.protocol, PROTOCOL_VERSION)) {
			this.close();
			throw new ProtocolVersionError(ready.protocol, PROTOCOL_VERSION);
		}
		this.ready = ready;
		return ready;
	}

	private control(control: ProtocolControl): void {
		if (!this.transport) throw new Error("session not started");
		// A dead engine (fd-3 EOF) cannot accept controls: surface the typed
		// lifecycle error instead of racing a write against the closed socket
		// (which throws write-after-end or emits an async EPIPE depending on
		// teardown timing).
		if (this.ended) throw new EngineExitedError("engine exited (control channel closed)");
		this.transport.send(control);
	}

	/** Send a user turn; resolves once the control is actually written —
	 * strictly ordered after any in-flight compaction cycle or queued turn
	 * initiator (M11 turn gate). Still fire-and-forget for the *turn* (pair
	 * with waitForEvent/interrupt, or prefer submitAndWait) — but the GATE
	 * stays held until the turn's idle (or engine EOF), so a compaction
	 * cycle can never start mid-turn and steal this turn's events into its
	 * exclusive stream. */
	async submit(text: string): Promise<void> {
		const release = await this.gate.acquire();
		try {
			this.control({ type: "submit", text });
		} catch (e) {
			release();
			throw e;
		}
		// Park the release on the turn's settling idle (fired by deliver(),
		// non-consuming; EOF flushes it). The caller resolves now.
		this.idleHooks.push(release);
	}

	/**
	 * Submit a user turn and resolve with its authoritative content at idle.
	 * Holds the turn gate from control write until the turn's own `idle`, so
	 * "the next idle after my submit" is provably mine (M11). A turn-scoped
	 * `error` is captured and the loop **drains to `idle`** (so the session
	 * settles at a clean boundary and a later submit works), then rejects
	 * with TurnError. A fatal fd-3 EOF mid-turn rejects with EngineExitedError.
	 */
	async submitAndWait(text: string): Promise<TurnResult> {
		const release = await this.gate.acquire();
		try {
			return await this.submitAndWaitUnlocked(text);
		} finally {
			release();
		}
	}

	private async submitAndWaitUnlocked(text: string): Promise<TurnResult> {
		this.control({ type: "submit", text });
		let result: TurnResult | undefined;
		let turnError: TurnError | undefined;
		for (;;) {
			const e = await this.nextEventWithin();
			if (e === null) throw new EngineExitedError("engine exited mid-turn");
			if (e.type === "assistant_turn_finished") {
				result = { turnId: e.turnId, content: e.content };
			} else if (e.type === "error") {
				turnError = new TurnError(e.message, e.turnId); // keep draining to idle
			} else if (e.type === "idle") {
				if (turnError) throw turnError;
				return result ?? { turnId: "", content: "" };
			}
		}
	}

	/** Compact history (M11, spec §1): replace everything but the trailing
	 * window with `summary`. Resolves on `compacted` (consuming the paired
	 * idle); rejects TurnError on an engine-rejected control and
	 * CompactTimeoutError when the engine never confirms in time. */
	async compact(
		summary: string,
		keepLastTurns: number,
		dropLastTurns: number,
	): Promise<CompactResult> {
		const release = await this.gate.acquire();
		try {
			return await this.compactUnlocked(summary, keepLastTurns, dropLastTurns);
		} finally {
			release();
		}
	}

	private async compactUnlocked(
		summary: string,
		keepLastTurns: number,
		dropLastTurns: number,
	): Promise<CompactResult> {
		// Spec §3: a hung compact (engine wedged, control path dead) must not
		// park the cycle forever — the gate would never release and the
		// Compactor's inProgress/re-arm bookkeeping would never run. The engine
		// applies compact synchronously between turns (an in-memory swap + log
		// rewrite), so the generous default only fires on a truly stuck engine.
		// Each wait carries the REMAINING budget and cancels its own waiter on
		// expiry (nextEventWithin) — no shared race, no orphaned waiter.
		const ms = this.options.compactTimeoutMs ?? 30_000;
		const startedAt = Date.now();
		const remaining = (): number => Math.max(1, ms - (Date.now() - startedAt));
		this.control({ type: "compact", summary, keepLastTurns, dropLastTurns });
		let sawCompacted = false;
		try {
			for (;;) {
				const e = await this.nextEventWithin(remaining());
				if (e === null) throw new EngineExitedError('engine exited before "compacted"');
				if (e.type === "error") throw new TurnError(e.message, e.turnId);
				if (e.type === "compacted") {
					sawCompacted = true;
					// consume the paired idle so the stream settles at a boundary
					for (;;) {
						const i = await this.nextEventWithin(remaining());
						if (i === null) throw new EngineExitedError('engine exited before "idle"');
						if (i.type === "idle") break;
					}
					return { droppedItems: e.droppedItems, keptTurns: e.keptTurns };
				}
			}
		} catch (e) {
			// Arm the stale swallow for exactly what never arrived: the whole
			// compacted+idle pair, or just the idle when compacted was already
			// consumed before the deadline hit (see deliver()).
			if (e instanceof CompactTimeoutError) {
				if (sawCompacted) this.swallowNextIdle = true;
				else this.staleCompactsPending++;
			}
			throw e;
		}
	}

	/** Run `fn` as one gated critical section with unlocked turn primitives
	 * (M11). While it runs, events route to the exclusive stream — outside
	 * `waitForEvent` callers see nothing until the cycle completes. The facet
	 * throws after `fn` settles (no escape). */
	async runExclusive<T>(fn: (s: ExclusiveSession) => Promise<T>): Promise<T> {
		const release = await this.gate.acquire();
		this.cycleInternal = true;
		let live = true;
		const guard = (): void => {
			if (!live) throw new Error("exclusive facet used after its critical section");
		};
		const facet: ExclusiveSession = {
			submitAndWait: (text) => {
				guard();
				return this.submitAndWaitUnlocked(text);
			},
			compact: (summary, keep, drop) => {
				guard();
				return this.compactUnlocked(summary, keep, drop);
			},
		};
		try {
			return await fn(facet);
		} finally {
			live = false;
			this.cycleInternal = false;
			// Drain the exclusive stream: every event produced during the cycle
			// belonged to the cycle's own controls, so leftovers (events that
			// arrived after a timeout, or were never consumed) must not leak to
			// the public stream. Dangling raced waiters are dropped too — their
			// promises lost their deadline and are unreferenced.
			this.exclusiveQueue.length = 0;
			this.exclusiveWaiters.length = 0;
			release();
		}
	}

	/** Cancel the in-flight turn. */
	interrupt(): void {
		this.control({ type: "interrupt" });
	}

	/** Advertise host-provided (delegated) tools to the engine. Call once after
	 * `start()`'s `ready` resolves and BEFORE the first submit, so the first turn
	 * sees them. Their results are returned via `sendToolResult` (M9). */
	registerDelegatedTools(tools: DelegatedToolDef[]): void {
		this.control({ type: "register_delegated_tools", tools });
	}

	/** Reply to a `tool_call_requested` (correlated by callId) (M9). */
	sendToolResult(callId: string, output: string, status: "ok" | "error"): void {
		this.control({ type: "tool_result", callId, output, status });
	}

	/** Re-fetch the last handback without re-running a turn (no clipboard).
	 * Resolves the re-emitted content; rejects TurnError if no prior response. */
	async copyLastResponse(): Promise<TurnResult> {
		this.control({ type: "copy_last_response" });
		const e = await this.waitForEvent("assistant_turn_finished"); // TurnError on no-prev
		if (e.type !== "assistant_turn_finished") throw new Error("unexpected event");
		return { turnId: e.turnId, content: e.content };
	}

	/** Switch this session to a past one: tear down the current hax child, reset
	 * lifecycle state, and respawn headless hax with `--resume=ID` plus the prior
	 * options. The constructor-bound onEvent stays attached. Rejects (engine left
	 * closed) on spawn/protocol failure. Refuses while a turn holds the gate. */
	async resume(sessionId: string, options: SpawnHaxOptions = {}): Promise<ReadyEvent> {
		if (this.gate.held) {
			throw new Error("cannot resume while a turn is in flight");
		}
		const release = await this.gate.acquire();
		try {
			const dying = this.pumpDone; // the OLD pump's completion
			this.generation += 1; // old generation now stale: its events + EOF go inert
			this.close(); // kill the old child + close the transport (old fd-3 EOFs)
			await dying; // let the old pump fully unwind (its finally is a no-op now)
			this.resetLifecycleLatches();
			const args = [...(options.args ?? []), `--resume=${sessionId}`];
			return await this.spawnAndPump({
				...options,
				args,
				transcriptPath: options.transcriptPath ?? this._transcriptPath,
			});
		} finally {
			release();
		}
	}

	/** Clear the close()/EOF latches and any parked stream state so the same
	 * Session object is reusable across a respawn. Safe only between turns (resume
	 * holds the gate, so no waiters are outstanding). */
	private resetLifecycleLatches(): void {
		this.closed = false;
		this.ended = false;
		this.ready = undefined;
		this.queue.length = 0;
		this.waiters.length = 0;
		this.exclusiveQueue.length = 0;
		this.exclusiveWaiters.length = 0;
		this.idleHooks.length = 0;
		this.swallowNextIdle = false;
		this.staleCompactsPending = 0;
		this.cycleInternal = false;
	}

	/** Start a fresh conversation; resolves once the engine is idle again.
	 * Gate-serialized like every turn initiator (M11). */
	async newConversation(): Promise<void> {
		const release = await this.gate.acquire();
		try {
			this.control({ type: "new_conversation" });
			for (;;) {
				const e = await this.nextEventWithin();
				if (e === null) throw new EngineExitedError('engine exited before "idle"');
				if (e.type === "idle") return;
			}
		} finally {
			release();
		}
	}

	/** Request an engine/session status event. */
	async status(): Promise<StatusEvent> {
		this.control({ type: "status" });
		return (await this.waitForEvent("status")) as StatusEvent;
	}

	/** Close the control channel (shuts the engine down) and stop the child.
	 * Idempotent — safe to call from both the version-gate teardown and the
	 * caller. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.transport?.close();
		} catch {
			/* already closed */
		}
		this.spawned?.child.kill();
	}
}
