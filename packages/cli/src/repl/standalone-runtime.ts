/**
 * Standalone self-mount assembly: spawn headless hax, render its protocol stream
 * through the M7/M8 surface, wire the MCP host into the loop, and drive input
 * with the line-buffered reader. This is the unified architecture — hax is
 * always headless; ezio (TS) owns the terminal — applied to the human REPL.
 */
import { Session } from "@ai-ezio/harness";
import { loadMcpHost, type McpHost } from "@ai-ezio/mcp-host";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createMountedRenderer } from "@ai-ezio/surface";
import { runStandaloneRepl } from "./standalone.js";

export interface OneShotOptions {
	/** Overrides for Session.start (binary/env/args) — for tests. */
	startOptions?: Parameters<Session["start"]>[0];
	/** Injectable host (tests); defaults to loadMcpHost from mcp.json. */
	host?: McpHost;
	out?: (s: string) => void;
	err?: (s: string) => void;
}

/**
 * `-p` one-shot, on the unified architecture: spawn headless hax, wire the MCP
 * host into the loop (so the model can call registered tools), submit the prompt,
 * print the authoritative handback, and exit. Non-interactive, so the host runs
 * in "mounted" policy mode (confirm → deny — no human to prompt). Returns the
 * process exit code.
 */
export async function runOneShot(prompt: string, opts: OneShotOptions = {}): Promise<number> {
	const out = opts.out ?? ((s: string) => void process.stdout.write(s));
	const err = opts.err ?? ((s: string) => void process.stderr.write(s));
	const host = opts.host ?? loadMcpHost({ mode: "mounted", cwd: process.cwd() });
	const session = new Session({ onEvent: (e: ProtocolEvent) => void host.handleEvent(e) });

	try {
		await session.start(opts.startOptions ?? {});
	} catch (error) {
		err(`ai-ezio: ${(error as Error).message}\n`);
		return 1;
	}
	// Register delegated tools BEFORE the submit so the one-shot turn sees them.
	await host.start(session);

	let code = 0;
	try {
		const r = await session.submitAndWait(prompt);
		out(r.content.endsWith("\n") ? r.content : `${r.content}\n`);
	} catch (error) {
		err(`ai-ezio: ${(error as Error).message}\n`);
		code = 1;
	} finally {
		await host.stop();
		session.close();
	}
	return code;
}

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
