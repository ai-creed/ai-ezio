/**
 * Inherited-fd transport: events arrive on a Readable (fd 3), controls are
 * written to a Writable (fd 4). The harness wires these from the hax child's
 * extra stdio streams.
 */
import type { Readable, Writable } from "node:stream";
import { encodeControl, JsonlDecoder } from "./codec.js";
import type { ProtocolControl } from "./controls.js";
import type { ProtocolEvent } from "./events.js";
import type { Transport } from "./transport.js";

export class FdTransport implements Transport {
	private readonly decoder = new JsonlDecoder();

	constructor(
		private readonly eventStream: Readable,
		private readonly controlStream: Writable,
	) {}

	async *events(): AsyncIterable<ProtocolEvent> {
		for await (const chunk of this.eventStream) {
			for (const event of this.decoder.push(chunk as Uint8Array)) {
				yield event;
			}
		}
	}

	send(control: ProtocolControl): void {
		this.controlStream.write(encodeControl(control));
	}

	close(): void {
		this.controlStream.end();
	}
}
