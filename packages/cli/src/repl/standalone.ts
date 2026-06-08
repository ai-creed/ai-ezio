/**
 * Self-mounted standalone REPL: a human drives headless hax through ezio's own
 * surface + MCP host. This module owns INPUT → submit + lifecycle; OUTPUT is
 * rendered elsewhere (the surface, subscribed via Session.onEvent).
 */
import type { Session } from "@ai-ezio/harness";
import type { McpHost } from "@ai-ezio/mcp-host";
import { feedKey, newLineBuffer } from "./input-reader.js";
import type { SlashController } from "./slash.js";

export interface StandaloneReplDeps {
	keys: AsyncIterable<string>;
	session: Pick<Session, "submit" | "interrupt" | "waitForEvent" | "close">;
	host: Pick<McpHost, "handleEvent" | "stop">;
	write: (s: string) => void;
	/** Local slash-command dispatch; a submitted line is routed here first. */
	slash: Pick<SlashController, "handle">;
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
			// Route every completed line through the local slash controller first.
			// A handled command never reaches hax (which would hang the REPL); only
			// a "submit" outcome is forwarded to the engine.
			const outcome = await deps.slash.handle(r.submit);
			if (outcome.action === "exit") break;
			if (outcome.action === "submit") {
				deps.session.submit(outcome.text);
				// Wait for the turn to settle before reading the next line. The surface
				// renders streamed events live via Session.onEvent; idle = prompt again.
				await deps.session.waitForEvent("idle");
			}
			// "handled" → fall through and prompt again (no engine round-trip).
		}
	}
	await deps.host.stop();
	deps.session.close();
}
