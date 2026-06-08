/**
 * Standalone self-mount assembly: spawn headless hax, render its protocol stream
 * through the M7/M8 surface, wire the MCP host into the loop, and drive input
 * with the line-buffered reader. This is the unified architecture — hax is
 * always headless; ezio (TS) owns the terminal — applied to the human REPL.
 */
import { Session } from "@ai-ezio/harness";
import { loadMcpHost } from "@ai-ezio/mcp-host";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createMountedRenderer } from "@ai-ezio/surface";
import { runStandaloneRepl } from "./standalone.js";

/** Decode a readable TTY into a stream of single characters (code points). */
async function* readKeys(stdin: NodeJS.ReadStream): AsyncGenerator<string> {
	for await (const chunk of stdin) {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (const ch of s) yield ch;
	}
}

/** Run the interactive standalone REPL. Returns the process exit code. */
export async function runStandalone(): Promise<number> {
	const host = loadMcpHost({ mode: "standalone", cwd: process.cwd() });
	const renderer = createMountedRenderer({ stdout: process.stdout });
	const session = new Session({
		onEvent: (e: ProtocolEvent) => {
			renderer.handle(e);
			void host.handleEvent(e);
		},
	});

	try {
		await session.start();
	} catch (error) {
		process.stderr.write(`ai-ezio: ${(error as Error).message}\n`);
		return 1;
	}

	// Register delegated tools BEFORE accepting input so the first turn sees them.
	await host.start(session);

	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	try {
		await runStandaloneRepl({
			keys: readKeys(stdin),
			session,
			host,
			write: (s) => void process.stdout.write(s),
		});
	} finally {
		stdin.setRawMode?.(false);
		stdin.pause();
	}
	return 0;
}
