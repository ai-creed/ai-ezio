/**
 * Promise-chain mutex serializing turn-initiating session operations
 * (submit / submitAndWait / newConversation / compact / runExclusive).
 * Non-reentrant by design — multi-step critical sections go through
 * Session.runExclusive, never through nested public calls.
 */
export class TurnGate {
	private tail: Promise<void> = Promise.resolve();

	/** Resolves with a release function once every earlier acquirer released. */
	acquire(): Promise<() => void> {
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const turn = this.tail.then(() => release);
		this.tail = this.tail.then(() => held);
		return turn;
	}
}
