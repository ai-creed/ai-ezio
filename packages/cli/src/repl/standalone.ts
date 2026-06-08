/**
 * Self-mounted standalone REPL: a human drives headless hax through ezio's own
 * surface + MCP host. This module owns INPUT → submit + lifecycle; OUTPUT is
 * rendered elsewhere (the surface, subscribed via Session.onEvent).
 */
import type { Session } from "@ai-ezio/harness";
import type { McpHost } from "@ai-ezio/mcp-host";
import { feedKey, newLineBuffer } from "./input-reader.js";

export interface StandaloneReplDeps {
	keys: AsyncIterable<string>;
	session: Pick<Session, "submit" | "interrupt" | "waitForEvent" | "close">;
	host: Pick<McpHost, "handleEvent" | "stop">;
	write: (s: string) => void;
}

/** The human REPL loop over headless hax: read a line → submit → wait for the
 * turn to settle (the surface renders streamed events live) → prompt again.
 * Ctrl-C interrupts the in-flight turn; Ctrl-D exits. */
export async function runStandaloneRepl(deps: StandaloneReplDeps): Promise<void> {
	let buffer = newLineBuffer();
	for await (const ch of deps.keys) {
		const r = feedKey(buffer, ch);
		buffer = r.buffer;
		if (r.echo) deps.write(r.echo);
		if (r.signal === "eof") break;
		if (r.signal === "interrupt") {
			deps.session.interrupt();
			continue;
		}
		if (r.submit !== undefined) {
			if (r.submit.trim() === "") continue;
			deps.session.submit(r.submit);
			// Wait for the turn to settle before reading the next line. The surface
			// renders streamed events live via Session.onEvent; idle = prompt again.
			await deps.session.waitForEvent("idle");
		}
	}
	await deps.host.stop();
	deps.session.close();
}
