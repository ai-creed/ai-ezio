/**
 * Standalone self-mount assembly: spawn headless hax, render its protocol stream
 * through the M7/M8 surface, wire the MCP host into the loop, and drive input
 * with the line-buffered reader. This is the unified architecture — hax is
 * always headless; ezio (TS) owns the terminal — applied to the human REPL.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { loadConfig, Session } from "@ai-ezio/harness";
import { loadMcpHost, type McpHost } from "@ai-ezio/mcp-host";
import type { AssistantTurnFinishedEvent, ProtocolEvent } from "@ai-ezio/protocol";
import { buildCompactor } from "./compaction-wiring.js";
import {
	createRecorder,
	ezioStateDir,
	recoverUncaptured,
	repoKeyForPath,
} from "@ai-ezio/session-recorder";
import {
	createMountedRenderer,
	discoverSkills,
	makeClipboard,
	nodeSkillFs,
	resolvePager,
	showTranscript as renderTranscript,
	transcriptFilePath,
	type SkillEnv,
} from "@ai-ezio/surface";
import { SlashController, type SlashContext } from "./slash.js";
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
	const cwd = process.cwd();
	const host = opts.host ?? loadMcpHost({ mode: "mounted", cwd });
	const stateDir = ezioStateDir();
	const repoKey = repoKeyForPath(cwd);
	// Even a one-shot `-p` is a (single-turn) session: record it for cortex too.
	const recorder = createRecorder({ worktreePath: cwd, host, stateDir, repoKey, warn: err });
	const session = new Session({
		onEvent: (e: ProtocolEvent) => {
			recorder.handleEvent(e);
			void host.handleEvent(e);
		},
	});

	try {
		await session.start(opts.startOptions ?? {});
	} catch (error) {
		err(`ai-ezio: ${(error as Error).message}\n`);
		return 1;
	}
	// Register delegated tools BEFORE the submit so the one-shot turn sees them.
	await host.start(session);
	// Recover any projection orphaned by a crash before its final capture (idempotent).
	await recoverUncaptured({ host, stateDir, repoKey, worktreePath: cwd, warn: err });

	let code = 0;
	try {
		recorder.noteSubmit(prompt);
		const r = await session.submitAndWait(prompt);
		out(r.content.endsWith("\n") ? r.content : `${r.content}\n`);
	} catch (error) {
		err(`ai-ezio: ${(error as Error).message}\n`);
		code = 1;
	} finally {
		// Await the final capture BEFORE tearing the host down, so the one-shot turn is
		// captured reliably (close() flushes the projection to cortex via callHostTool).
		await recorder.close();
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

export interface StandaloneOptions {
	/** Forwarded to the headless hax spawn (e.g. ["--continue"] or ["--resume=ID"])
	 * to resume a prior session. Absent/empty → a fresh session. */
	resumeArgs?: string[];
}

/**
 * The one-line "resumed" notice ezio prints on a resume launch. The engine's own
 * startup replay is a TTY-only no-op under the self-mount (hax's stdout is
 * ignored), so without this the user gets no signal that history was loaded.
 * Count-free: the "N earlier messages" count lives only inside hax and surfacing
 * it would need a new engine seam we deliberately avoid. Returns undefined for a
 * fresh (non-resume) launch. Pure.
 */
export function resumeNotice(resumeArgs?: string[]): string | undefined {
	if (!resumeArgs?.length) return undefined;
	const id = resumeArgs.map((a) => /^--resume=(.+)$/.exec(a)?.[1]).find(Boolean);
	const what = id ? `session ${id.slice(0, 8)}` : "most recent session";
	return `\x1b[2m─ resumed ${what} · history loaded as context ─\x1b[0m\n`;
}

/**
 * Mint the pre-spawn transcript path, ensure its directory exists, and start the
 * session with it — all BEFORE any `ready`-dependent work. The filename is a
 * caller-minted id, NOT the protocol `ready.sessionId` (which does not exist
 * until after spawn, while hax opens `HAX_TRANSCRIPT` before emitting `ready`).
 * Returns the finalized path. The `mintId`/`ensureDir` seams keep the ordering
 * unit-testable; production defaults are `randomUUID` + `mkdirSync`.
 */
export async function startWithTranscript(
	session: Pick<Session, "start">,
	opts: {
		stateDir: string;
		repoKey: string;
		resumeArgs?: string[];
		mintId?: () => string;
		ensureDir?: (dir: string) => void;
	},
): Promise<string> {
	const id = (opts.mintId ?? randomUUID)();
	const transcriptPath = transcriptFilePath(opts.stateDir, opts.repoKey, id);
	const ensureDir = opts.ensureDir ?? ((dir: string) => void mkdirSync(dir, { recursive: true }));
	ensureDir(dirname(transcriptPath));
	await session.start({
		...(opts.resumeArgs?.length ? { args: opts.resumeArgs } : {}),
		transcriptPath,
	});
	return transcriptPath;
}

/** Run the interactive standalone REPL. Returns the process exit code. */
export async function runStandalone(opts: StandaloneOptions = {}): Promise<number> {
	const cwd = process.cwd();
	const host = loadMcpHost({ mode: "standalone", cwd });
	const stateDir = ezioStateDir();
	const repoKey = repoKeyForPath(cwd);
	// Session recorder: assemble turns from the protocol stream and feed cortex a
	// Claude-format transcript via the host-private capture_session call. Cortex-blind
	// except for the injected CortexSessionSink (inside createRecorder).
	const recorder = createRecorder({ worktreePath: cwd, host, stateDir, repoKey });
	const renderer = createMountedRenderer({ stdout: process.stdout });
	let lastContent = "";
	let lastUsage: AssistantTurnFinishedEvent["usage"];
	// Compaction (M11): wired after the session exists (it needs runExclusive),
	// but the tee below already consults it — declare the slot first.
	let wired: ReturnType<typeof buildCompactor> | undefined;
	const session = new Session({
		onEvent: (e: ProtocolEvent) => {
			// During a compaction cycle the summarize turn is plumbing, not
			// conversation: suppress its rendering ("compacting…" chrome shows
			// instead). The recorder and host still see every event.
			if (!wired?.compacting()) renderer.handle(e);
			recorder.handleEvent(e);
			if (e.type === "assistant_turn_finished") {
				lastContent = e.content;
				lastUsage = e.usage;
				wired?.compactor.noteUsage(e.usage);
			}
			void host.handleEvent(e);
		},
	});
	const { compaction } = loadConfig();
	wired = buildCompactor({
		session,
		config: compaction,
		host,
		digest: recorder,
		write: (s) => void process.stdout.write(s),
	});

	try {
		// resumeArgs (e.g. ["--continue"]/["--resume=ID"]) make the headless hax
		// load + replay prior history before the first prompt; absent → fresh.
		// Pre-spawn: mint the HAX_TRANSCRIPT path + create its dir BEFORE start, as
		// hax opens the mirror before emitting `ready` (no protocol session id yet).
		// The path is re-exposed as session.transcriptPath for the view closure.
		await startWithTranscript(session, { stateDir, repoKey, resumeArgs: opts.resumeArgs });
	} catch (error) {
		process.stderr.write(`ai-ezio: ${(error as Error).message}\n`);
		return 1;
	}

	// Register delegated tools BEFORE accepting input so the first turn sees them.
	await host.start(session);
	// Recover any projection orphaned by a crash before its final capture (idempotent).
	await recoverUncaptured({ host, stateDir, repoKey, worktreePath: cwd });

	// Build the local slash controller with real capabilities. Skills are
	// rediscovered per /skills call (cheap; reflects on-disk changes).
	const skillEnv: SkillEnv = {
		cwd: process.cwd(),
		home: homedir(),
		xdgConfigHome: process.env.XDG_CONFIG_HOME,
	};
	const skillFs = nodeSkillFs();
	// The Ctrl+T / `/transcript` view: page the HAX_TRANSCRIPT mirror, suspending
	// raw mode around the pager. session.transcriptPath is the harness-owned path.
	const showTranscript = () =>
		renderTranscript({
			path: session.transcriptPath,
			readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
			interactive: Boolean(process.stdout.isTTY),
			spawnPager: (file) =>
				new Promise<void>((resolve, reject) => {
					// Default keeps `cmd` a definite string under noUncheckedIndexedAccess;
					// resolvePager never returns empty, so the fallback is unreachable.
					const [cmd = "less", ...rest] = resolvePager(process.env).split(/\s+/);
					const child = spawn(cmd, [...rest, file], { stdio: "inherit" });
					child.on("error", reject);
					child.on("exit", () => resolve());
				}),
			suspendRaw: () => void process.stdin.setRawMode?.(false),
			restoreRaw: () => void process.stdin.setRawMode?.(true),
			write: (s) => void process.stdout.write(s),
		});
	const slashCtx: SlashContext = {
		write: (s) => void process.stdout.write(s),
		session,
		recorder,
		compactor: wired.compactor,
		lastContent: () => lastContent,
		lastUsage: () => lastUsage,
		skills: () =>
			discoverSkills(skillEnv, skillFs).map((s) => ({
				name: s.name,
				source: s.source,
				description: s.description,
			})),
		clipboard: makeClipboard(process.platform, spawn),
		showTranscript,
	};
	const slash = new SlashController(slashCtx);

	// On a resume launch, the engine replay is a TTY-only no-op under the
	// self-mount, so surface a one-line notice (after the banner has rendered).
	const notice = resumeNotice(opts.resumeArgs);
	if (notice) process.stdout.write(notice);

	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	// Enable bracketed paste (ESC[?2004h) so a pasted block arrives wrapped in
	// ESC[200~…ESC[201~ markers (feedKey treats the embedded newlines as literal
	// instead of submitting at the first one), and push the kitty keyboard protocol
	// (ESC[>1u, disambiguate flag) so Shift+Enter arrives as CSI 13;2u instead of a
	// bare CR indistinguishable from a plain Enter. Both are ignored by terminals
	// that don't support them, so this degrades gracefully.
	process.stdout.write("\x1b[?2004h\x1b[>1u");
	try {
		await runStandaloneRepl({
			keys: readKeys(stdin),
			session,
			host,
			compactor: wired.compactor,
			write: (s) => void process.stdout.write(s),
			slash,
			recorder,
			echoSubmittedInput: renderer.echoSubmittedInput,
			renderPrompt: renderer.renderPrompt,
			showTranscript,
		});
	} finally {
		// Pop the kitty flags and restore the terminal's paste mode.
		process.stdout.write("\x1b[<u\x1b[?2004l");
		stdin.setRawMode?.(false);
		stdin.pause();
	}
	return 0;
}
