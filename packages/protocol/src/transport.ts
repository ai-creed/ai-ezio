/**
 * Transport seam. The wire format (JSONL) is identical across transports, so the
 * fd transport is just the first implementation; a socket/stdio transport can be
 * added later behind this same interface without touching schema, codec, harness,
 * or hax.
 */
import type { ProtocolControl } from "./controls.js";
import type { ProtocolEvent } from "./events.js";

export interface Transport {
	/** Async iterable of decoded events (hax → harness). */
	events(): AsyncIterable<ProtocolEvent>;
	/** Send one control (harness → hax). */
	send(control: ProtocolControl): void;
	/** Close the control channel (signals shutdown to the engine). */
	close(): void;
}
