/**
 * JSONL codec: UTF-8, one JSON object per `\n`-terminated line.
 *
 * `JsonlDecoder` buffers partial lines across chunks (reads arrive in arbitrary
 * sizes) and surfaces a malformed line as a typed error rather than dropping it
 * silently.
 */
import type { ProtocolControl } from "./controls.js";
import type { ProtocolEvent } from "./events.js";

export class MalformedLineError extends Error {
	constructor(public readonly line: string) {
		super(`malformed JSONL line: ${JSON.stringify(line)}`);
		this.name = "MalformedLineError";
	}
}

/** Encode one control as a JSONL line (with trailing newline). */
export function encodeControl(control: ProtocolControl): string {
	return `${JSON.stringify(control)}\n`;
}

/** Encode one event as a JSONL line — used by tests/fixtures and fakes. */
export function encodeEvent(event: ProtocolEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** Incremental decoder: feed chunks, get whole events out. */
export class JsonlDecoder {
	private buffer = "";

	/**
	 * Append a chunk and return every complete event it produced. A trailing
	 * partial line is retained until the rest arrives. Throws
	 * MalformedLineError on a complete-but-unparseable line (the buffer past it
	 * is preserved so decoding can continue after the caller handles it).
	 */
	push(chunk: string | Uint8Array): ProtocolEvent[] {
		this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		const events: ProtocolEvent[] = [];
		let nl = this.buffer.indexOf("\n");
		while (nl >= 0) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					throw new MalformedLineError(line);
				}
				events.push(parsed as ProtocolEvent);
			}
			nl = this.buffer.indexOf("\n");
		}
		return events;
	}

	/** Bytes buffered but not yet terminated by a newline. */
	get pending(): string {
		return this.buffer;
	}
}
