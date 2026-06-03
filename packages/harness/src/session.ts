/**
 * Session: drives one hax engine over the protocol. Owns the child + transport,
 * applies the `ready` version gate, and exposes the turn lifecycle as a typed
 * API. `idle` is treated as the only safe point to issue the next `submit`.
 */
import {
	FdTransport,
	isProtocolCompatible,
	PROTOCOL_VERSION,
	type ProtocolControl,
	type ProtocolEvent,
	type ReadyEvent,
	type Transport,
} from "@ai-ezio/protocol";
import { spawnHax, type SpawnedHax, type SpawnHaxOptions } from "./spawn.js";

export class ProtocolVersionError extends Error {
	constructor(theirs: string, ours: string) {
		super(`unsupported engine protocol ${theirs} (harness speaks ${ours})`);
		this.name = "ProtocolVersionError";
	}
}

/** A completed user turn. */
export interface TurnResult {
	turnId: string;
	/** Authoritative handback (assistant_turn_finished.content). */
	content: string;
}

export interface SessionOptions {
	/** Observer (tee) called for every event, in order, before consumption.
	 * Non-consuming — useful for recording the full sequence in tests/loggers. */
	onEvent?: (event: ProtocolEvent) => void;
}

export class Session {
	private spawned?: SpawnedHax;
	private transport?: Transport;
	private readonly queue: ProtocolEvent[] = [];
	private readonly waiters: Array<(e: ProtocolEvent | null) => void> = [];
	private ended = false;
	ready?: ReadyEvent;

	constructor(private readonly options: SessionOptions = {}) {}

	private deliver(event: ProtocolEvent | null): void {
		if (event && this.options.onEvent) this.options.onEvent(event);
		const w = this.waiters.shift();
		if (w) w(event);
		else if (event) this.queue.push(event);
	}

	private next(): Promise<ProtocolEvent | null> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (this.ended) return Promise.resolve(null);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Consume events until one of the given type arrives. */
	async waitForEvent(type: ProtocolEvent["type"]): Promise<ProtocolEvent> {
		for (;;) {
			const e = await this.next();
			if (e === null) throw new Error(`engine ended before "${type}"`);
			if (e.type === "error" && type !== "error") {
				throw new Error(`engine error: ${e.message}`);
			}
			if (e.type === type) return e;
		}
	}

	/** Spawn hax, pump events, and gate on the `ready` protocol version. */
	async start(options: SpawnHaxOptions = {}): Promise<ReadyEvent> {
		const spawned = spawnHax(options);
		this.spawned = spawned;
		const transport = new FdTransport(spawned.eventStream, spawned.controlStream);
		this.transport = transport;
		void (async () => {
			try {
				for await (const event of transport.events()) this.deliver(event);
			} finally {
				this.ended = true;
				while (this.waiters.length) this.deliver(null);
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
		this.transport.send(control);
	}

	/** Send a user turn without waiting (pair with waitForEvent/interrupt). */
	submit(text: string): void {
		this.control({ type: "submit", text });
	}

	/** Submit a user turn and resolve with its authoritative content at idle. */
	async submitAndWait(text: string): Promise<TurnResult> {
		this.control({ type: "submit", text });
		let result: TurnResult | undefined;
		for (;;) {
			const e = await this.next();
			if (e === null) throw new Error("engine ended mid-turn");
			if (e.type === "assistant_turn_finished") {
				result = { turnId: e.turnId, content: e.content };
			} else if (e.type === "idle") {
				return result ?? { turnId: "", content: "" };
			} else if (e.type === "error") {
				throw new Error(`engine error: ${e.message}`);
			}
		}
	}

	/** Cancel the in-flight turn. */
	interrupt(): void {
		this.control({ type: "interrupt" });
	}

	/** Close the control channel (shuts the engine down) and stop the child. */
	close(): void {
		try {
			this.transport?.close();
		} catch {
			/* already closed */
		}
		this.spawned?.child.kill();
	}
}
