/**
 * Promise-chain mutex serializing turn-initiating session operations
 * (submit / submitAndWait / newConversation / compact / runExclusive).
 * Non-reentrant by design — multi-step critical sections go through
 * Session.runExclusive, never through nested public calls.
 */
export class TurnGate {
	private tail: Promise<void> = Promise.resolve();
	private heldCount = 0;

	/** True while any acquirer (queued or active) is outstanding. */
	get held(): boolean {
		return this.heldCount > 0;
	}

	/** Resolves with a release function once every earlier acquirer released.
	 * The release is idempotent: calling it twice must not double-decrement
	 * `heldCount` (a corrupted count would report `held === false` while a
	 * later acquirer still holds the gate). */
	acquire(): Promise<() => void> {
		this.heldCount += 1;
		let release!: () => void;
		const held = new Promise<void>((r) => {
			let released = false;
			release = () => {
				if (released) return;
				released = true;
				this.heldCount -= 1;
				r();
			};
		});
		const turn = this.tail.then(() => release);
		this.tail = this.tail.then(() => held);
		return turn;
	}
}
