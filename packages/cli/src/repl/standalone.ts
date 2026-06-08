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
	/** Repaint a just-submitted line as the magenta `▌ ` user-turn block (erases
	 * the plain keystroke echo first). Makes commands AND prompts read as a turn,
	 * matching hax. */
	echoSubmittedInput: (text: string) => void;
	/** Draw a fresh input prompt. Used after a locally-handled command, where no
	 * `idle` event follows to draw one. */
	renderPrompt: () => void;
}

/** The human REPL loop over headless hax: read a line → submit → wait for the
 * turn to settle (the surface renders streamed events live) → prompt again.
 * Ctrl-C interrupts the in-flight turn; Ctrl-D exits. */
export async function runStandaloneRepl(deps: StandaloneReplDeps): Promise<void> {
	let buffer = newLineBuffer();
	for await (const ch of deps.keys) {
		const r = feedKey(buffer, ch);
		buffer = r.buffer;
		// Echo keystrokes as typed — but suppress Enter's newline on a submit: the
		// line is about to be repainted as the magenta user-turn block, so the
		// cursor must stay at the end of the echoed text for echoSubmittedInput's
		// erase to land on the right rows.
		if (r.echo && r.submit === undefined) deps.write(r.echo);
		if (r.signal === "eof") break;
		if (r.signal === "interrupt") {
			deps.session.interrupt();
			continue;
		}
		if (r.submit !== undefined) {
			if (r.submit.trim() === "") {
				deps.write("\r\n"); // empty line — advance, no turn to render
				continue;
			}
			// Repaint the submitted line (command OR prompt) as the magenta block,
			// the way hax treats every submission as a user turn.
			deps.echoSubmittedInput(r.submit);
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
			} else {
				// "handled" — no engine round-trip and so no idle to draw the next
				// prompt; draw it here so the pane stays usable.
				deps.renderPrompt();
			}
		}
	}
	await deps.host.stop();
	deps.session.close();
}
