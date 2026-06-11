/**
 * Self-mounted standalone REPL: a human drives headless hax through ezio's own
 * surface + MCP host. This module owns INPUT → submit + lifecycle; OUTPUT is
 * rendered elsewhere (the surface, subscribed via Session.onEvent).
 */
import type { Session } from "@ai-ezio/harness";
import type { McpHost } from "@ai-ezio/mcp-host";
import type { SessionRecorder } from "@ai-ezio/session-recorder";
import { feedKey, newLineBuffer } from "./input-reader.js";
import type { SlashController } from "./slash.js";

export interface StandaloneReplDeps {
	keys: AsyncIterable<string>;
	session: Pick<Session, "submitAndWait" | "interrupt" | "close">;
	host: Pick<McpHost, "handleEvent" | "stop">;
	/** Optional compaction policy (M11): the auto trigger runs after each
	 * settled turn; /compact reaches it through the slash context. */
	compactor?: { maybeAutoCompact(): Promise<unknown> };
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
	/** Optional transcript view (Ctrl+T): pages hax's HAX_TRANSCRIPT mirror.
	 * Local-only — no engine round-trip. */
	showTranscript?: () => Promise<void>;
	/** Optional session recorder — told the authoritative submit text before each
	 * turn and closed on REPL exit so the final turn is captured. */
	recorder?: Pick<SessionRecorder, "noteSubmit" | "close">;
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
		if (r.signal === "transcript") {
			await deps.showTranscript?.();
			// The view cleared/scrolled the screen; redraw the input line. Re-echo
			// any in-progress text so a draft typed before Ctrl+T is not lost.
			deps.renderPrompt();
			if (buffer.text) deps.write(buffer.text);
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
				deps.recorder?.noteSubmit(outcome.text);
				// Gated full-turn primitive (M11): holds the turn gate from control
				// write to this turn's OWN idle — never a compaction cycle's. The
				// surface renders streamed events live via Session.onEvent; the
				// resolved content is already on screen, so it is discarded here.
				await deps.session.submitAndWait(outcome.text);
				// Auto-compact check at the settled boundary; a cycle runs under
				// the same gate and re-checks fullness after acquiring it.
				await deps.compactor?.maybeAutoCompact();
			} else {
				// "handled" — no engine round-trip and so no idle to draw the next
				// prompt; draw it here so the pane stays usable.
				deps.renderPrompt();
			}
		}
	}
	await deps.recorder?.close();
	await deps.host.stop();
	deps.session.close();
}
