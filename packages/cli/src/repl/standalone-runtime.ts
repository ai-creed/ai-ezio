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
import {
	createRenameController,
	createSessionTitleStore,
	DelegatedToolRegistry,
	loadConfig,
	resolveHaxBinary,
	Session,
	type SessionOptions,
} from "@ai-ezio/harness";
import { loadSessionHosts } from "@ai-ezio/session-hosts";
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
	runResumeFlow,
	showTranscript as renderTranscript,
	transcriptFilePath,
	SlashController,
	type SlashContext,
	type SkillEnv,
} from "@ai-ezio/surface";
import { stdinChunks } from "../cli.js";
import { spawnListSessions } from "./resume-picker.js";
import { runStandaloneRepl } from "./standalone.js";

/** Wrap a raw writer so the subagent's one-line summary is newline-terminated on the surface. */
export function subagentReportLine(write: (s: string) => void): (line: string) => void {
	return (line) => write(line.endsWith("\n") ? line : `${line}\n`);
}

/** Options for the main mounted Session — always pins engine auto-compaction OFF
 * (HAX_COMPACT_AUTO=0) so no start/resume path can leak an inherited =1. The harness
 * owns compaction for the main session; subagent children pin =1 via profileEnv. */
export function mountedSessionOptions(base: SessionOptions = {}): SessionOptions {
	return { ...base, engineEnvOverrides: { ...base.engineEnvOverrides, HAX_COMPACT_AUTO: "0" } };
}

/** Default Session factory — overridable via the `makeSession` seam so a wiring
 * test can spy the exact options each entry point constructs its Session with.
 * The default deliberately does NOT add the override: it comes from the call
 * site's mountedSessionOptions wrap, so a skipped wrap fails the wiring test. */
const defaultMakeSession = (options: SessionOptions): Session => new Session(options);

export interface OnEventDeps {
	registry: Pick<DelegatedToolRegistry, "handleEvent">;
	recorder: { handleEvent: (e: ProtocolEvent) => void };
	rename?: { noteEvent: (e: ProtocolEvent) => void };
	renderer?: { handle: (e: ProtocolEvent) => void };
	compacting?: () => boolean;
	onFinished?: (e: AssistantTurnFinishedEvent) => void;
}

/** Interactive (runStandalone) onEvent fan. */
export function makeStandaloneOnEvent(deps: OnEventDeps): (e: ProtocolEvent) => void {
	return (e) => {
		deps.rename?.noteEvent(e);
		if (!deps.compacting?.()) deps.renderer?.handle(e);
		deps.recorder.handleEvent(e);
		if (e.type === "assistant_turn_finished") deps.onFinished?.(e);
		deps.registry.handleEvent(e);
	};
}

/** One-shot (runOneShot) onEvent fan. */
export function makeOneShotOnEvent(
	deps: Pick<OnEventDeps, "recorder" | "registry">,
): (e: ProtocolEvent) => void {
	return (e) => {
		deps.recorder.handleEvent(e);
		deps.registry.handleEvent(e);
	};
}

export interface OneShotOptions {
	/** Overrides for Session.start (binary/env/args) — for tests. */
	startOptions?: Parameters<Session["start"]>[0];
	out?: (s: string) => void;
	err?: (s: string) => void;
	/** Test seam: construct the Session (defaults to `new Session`). */
	makeSession?: (options: SessionOptions) => Session;
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
	const { registry, mcpHost } = loadSessionHosts({
		mode: "mounted",
		cwd,
		report: subagentReportLine(err),
	});
	const stateDir = ezioStateDir();
	const repoKey = repoKeyForPath(cwd);
	// Even a one-shot `-p` is a (single-turn) session: record it for cortex too.
	const recorder = createRecorder({
		worktreePath: cwd,
		host: mcpHost,
		stateDir,
		repoKey,
		warn: err,
	});
	const session = (opts.makeSession ?? defaultMakeSession)(
		mountedSessionOptions({ onEvent: makeOneShotOnEvent({ recorder, registry }) }),
	);

	try {
		await session.start(opts.startOptions ?? {});
	} catch (error) {
		err(`ai-ezio: ${(error as Error).message}\n`);
		return 1;
	}
	// Register delegated tools BEFORE the submit so the one-shot turn sees them.
	await registry.start(session);
	// Recover any projection orphaned by a crash before its final capture (idempotent).
	await recoverUncaptured({ host: mcpHost, stateDir, repoKey, worktreePath: cwd, warn: err });

	let code = 0;
	try {
		recorder.noteSubmit(prompt);
		const r = await session.submitAndWait(prompt);
		out(r.content.endsWith("\n") ? r.content : `${r.content}\n`);
	} catch (error) {
		err(`ai-ezio: ${(error as Error).message}\n`);
		code = 1;
	} finally {
		// Await the final capture BEFORE tearing the registry down, so the one-shot turn is
		// captured reliably (close() flushes the projection to cortex via callHostTool).
		await recorder.close();
		await registry.stop();
		session.close();
	}
	return code;
}

/** Split whole stdin chunks into single code points for the line reader. The
 * REPL's `feedKey` runs its own ESC accumulator, so it must see one code point at
 * a time; the picker overlay, by contrast, needs WHOLE chunks (see below). Yields
 * lazily off the shared chunk source. */
export async function* codePoints(src: AsyncIterable<string>): AsyncGenerator<string> {
	for await (const chunk of src) for (const ch of chunk) yield ch;
}

/**
 * Derive both standalone input views from ONE whole-chunk stdin source so the
 * line reader and the `/resume` overlay agree on chunking:
 *
 *  - `replKeys` — code points for `runStandaloneRepl` (its `feedKey` owns the ESC
 *    accumulator, so it must see one code point at a time).
 *  - `borrowChunks()` — WHOLE chunks for the picker overlay, so `decodeChunk` gets
 *    a complete escape sequence (e.g. `"\x1b[B"`) in one item instead of the bare
 *    `"\x1b"` first byte (which it would read as cancel).
 *
 * The two views never read concurrently: the REPL is parked in `await slash.handle`
 * while the overlay runs, and the code-point generator is suspended at its `yield`
 * with no pending read on the chunk source — so a single shared chunk iterator is
 * safe. `borrowChunks` is non-closing (its `return` is a no-op) so an overlay can
 * `for await` + break without ending the shared source; only `chunkSource.return`
 * (via `onFatal`) ends it. Extracted + exported so the production stream wiring is
 * unit-testable.
 */
export function buildStandaloneKeySources(chunkSource: AsyncIterator<string>): {
	replKeys: AsyncGenerator<string>;
	borrowChunks: () => AsyncIterable<string>;
} {
	const borrowChunks = (): AsyncIterable<string> => ({
		[Symbol.asyncIterator]: () => ({
			next: () => chunkSource.next(),
			return: async () => ({ done: true as const, value: undefined }),
		}),
	});
	return { replKeys: codePoints(borrowChunks()), borrowChunks };
}

/**
 * Build the standalone `/resume` overlay runner: hand the picker WHOLE chunks + a
 * raw-mode toggle, run it, then ALWAYS restore the REPL's raw mode (ON) afterward.
 *
 * The shared `runResumePicker`'s `finally` unconditionally calls `setRawMode(false)`
 * — correct for the STARTUP picker (the process then exits or re-mounts, which
 * re-enables raw), but WRONG for the in-REPL overlay: the standalone REPL keeps
 * running after `/resume`, so it must get raw mode back ON or its Ctrl-C / arrow /
 * paste line-reader semantics break. This runner restores raw ON in its own
 * `finally`, regardless of how the picker (or a throw) left it — mirroring the
 * mounted `runInteractiveOverlay`'s restore. Exported for unit testing.
 */
export function makeStandaloneOverlay(deps: {
	borrowChunks: () => AsyncIterable<string>;
	write: (s: string) => void;
	setRawMode: (on: boolean) => void;
}): (
	run: (io: {
		keys: AsyncIterable<string>;
		write: (s: string) => void;
		setRawMode: (on: boolean) => void;
	}) => Promise<void>,
) => Promise<void> {
	return async (run) => {
		try {
			await run({ keys: deps.borrowChunks(), write: deps.write, setRawMode: deps.setRawMode });
		} finally {
			deps.setRawMode(true); // restore the REPL's raw mode — the picker's finally turns it off
		}
	};
}

export interface StandaloneOptions {
	/** Forwarded to the headless hax spawn (e.g. ["--continue"] or ["--resume=ID"])
	 * to resume a prior session. Absent/empty → a fresh session. */
	resumeArgs?: string[];
	/** Test seam: construct the Session (defaults to `new Session`). */
	makeSession?: (options: SessionOptions) => Session;
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

/** Collaborators required to build the resume-flow deps for a standalone session. */
export interface StandaloneResumeDepsInput {
	session: Pick<Session, "resume">;
	registry: Pick<DelegatedToolRegistry, "start">;
	titleStore: ReturnType<typeof createSessionTitleStore>;
	rename: ReturnType<typeof createRenameController>;
	/** The shared whole-chunk stdin source. `onFatal` ends it (via `.return`) to
	 * break the REPL loop on its next pull. */
	chunkSource: Pick<AsyncGenerator<string>, "return">;
	write: (s: string) => void;
	listSessions: () => Promise<string>;
}

/**
 * Build the `ResumeFlowDeps`-shaped subset that wires the standalone session's
 * production resume path: `resume(id)` calls `session.resume(id)` then
 * `registry.start(session)` (order matters per spec §3) and writes the resume
 * notice; `onFatal` calls `chunkSource.return` to break the REPL loop.
 *
 * Extracted so tests can drive the REAL wiring with fakes instead of
 * re-proving `runResumeFlow`'s own contract.
 */
export function buildStandaloneResumeDeps(input: StandaloneResumeDepsInput): {
	resume: (id: string) => Promise<void>;
	onFatal: () => void;
	isBusy: () => boolean;
	listSessions: () => Promise<string>;
	titles: () => Map<string, string>;
	currentSessionId: () => string | undefined;
} {
	const { session, registry, titleStore, rename, chunkSource, write, listSessions } = input;
	return {
		isBusy: () => false,
		listSessions,
		titles: () => titleStore.loadTitles(),
		currentSessionId: () => rename.currentSessionId(),
		resume: async (id: string) => {
			await session.resume(id); // rejects on bad id / spawn / protocol failure
			await registry.start(session as Session); // rebuilds routing on the fresh child
			write(resumeNotice([`--resume=${id}`]) ?? "");
		},
		// Spec §4: a failed respawn leaves the engine closed and unrecoverable.
		// Ending the shared chunk source breaks runStandaloneRepl's loop on its
		// next pull → normal teardown (recorder.close → host.stop → session.close).
		onFatal: () => void chunkSource.return?.(undefined),
	};
}

/** Run the interactive standalone REPL. Returns the process exit code. */
export async function runStandalone(opts: StandaloneOptions = {}): Promise<number> {
	const cwd = process.cwd();
	const { registry, mcpHost } = loadSessionHosts({
		mode: "standalone",
		cwd,
		report: subagentReportLine((s) => process.stdout.write(s)),
	});
	const stateDir = ezioStateDir();
	const repoKey = repoKeyForPath(cwd);
	// Session recorder: assemble turns from the protocol stream and feed cortex a
	// Claude-format transcript via the host-private capture_session call. Cortex-blind
	// except for the injected CortexSessionSink (inside createRecorder).
	const recorder = createRecorder({ worktreePath: cwd, host: mcpHost, stateDir, repoKey });
	const renderer = createMountedRenderer({ stdout: process.stdout });
	let lastContent = "";
	let lastUsage: AssistantTurnFinishedEvent["usage"];
	// Compaction (M11): wired after the session exists (it needs runExclusive),
	// but the tee below already consults it — declare the slot first.
	let wired: ReturnType<typeof buildCompactor> | undefined;

	// §1C rename controller: tracks the hax session id and buffers pending titles.
	// Built before Session so the onEvent tee can close over it from the start.
	const titleStore = createSessionTitleStore();
	const rename = createRenameController({
		store: titleStore,
		// Defer off the delivery turn: noteEvent runs inside Session.deliver()'s
		// onEvent tee, BEFORE the event reaches waiters, so issuing status()
		// synchronously could register a waiter that steals the turn's settling idle.
		// queueMicrotask runs it after the idle has been routed to submitAndWait.
		requestStatus: () => queueMicrotask(() => void session.status().catch(() => {})),
	});

	const session = (opts.makeSession ?? defaultMakeSession)(
		mountedSessionOptions({
			onEvent: makeStandaloneOnEvent({
				registry,
				rename,
				renderer,
				recorder,
				compacting: () => !!wired?.compacting(),
				onFinished: (e) => {
					lastContent = e.content;
					lastUsage = e.usage;
					wired?.compactor.noteUsage(e.usage);
				},
			}),
		}),
	);
	const { compaction } = loadConfig();
	wired = buildCompactor({
		session,
		config: compaction,
		host: mcpHost,
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
	await registry.start(session);
	// Recover any projection orphaned by a crash before its final capture (idempotent).
	await recoverUncaptured({ host: mcpHost, stateDir, repoKey, worktreePath: cwd });

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

	const stdin = process.stdin;

	// ONE whole-chunk stdin source feeds BOTH consumers, so they agree on chunking.
	// stdinChunks yields raw stdin a chunk at a time (escape sequences arrive whole)
	// and does NOT destroy the stream on a consumer's break — the overlay can stop
	// pulling without EOFing the REPL.
	const chunkSource = stdinChunks(stdin);
	// replKeys: code points for the line reader (feedKey owns the ESC accumulator).
	// borrowChunks(): WHOLE chunks for the /resume overlay, so decodeChunk sees a
	// complete escape sequence (e.g. "\x1b[B") instead of the bare "\x1b" first byte
	// (which it would misread as cancel). The two views never read concurrently: the
	// REPL is parked in `await slash.handle` while the overlay runs.
	const { replKeys, borrowChunks } = buildStandaloneKeySources(chunkSource);

	// §3 resume thunk: list → pick → respawn + re-wire. The session-specific deps
	// (resume / onFatal / isBusy / listSessions / titles / currentSessionId) come from
	// buildStandaloneResumeDeps so the production wiring is unit-testable. The banner
	// repaints itself: session.resume emits a fresh `ready`, which resets the
	// renderer's one-shot banner flag (mounted-renderer handle("ready")), and
	// --mount-mode auto-emits `status` right after — redrawing the banner for the
	// resumed session. No explicit renderer call is needed.
	const resumeThunk = () =>
		runResumeFlow({
			...buildStandaloneResumeDeps({
				session,
				registry,
				titleStore,
				rename,
				chunkSource,
				write: (s) => void process.stdout.write(s),
				listSessions: () => spawnListSessions(resolveHaxBinary(), cwd),
			}),
			write: (s) => void process.stdout.write(s),
			// The picker's finally leaves raw mode OFF; this runner restores it ON so
			// the REPL's line reader keeps working after /resume (see makeStandaloneOverlay).
			runOverlay: makeStandaloneOverlay({
				borrowChunks,
				write: (s) => void process.stdout.write(s),
				setRawMode: (on) => void process.stdin.setRawMode?.(on),
			}),
			now: () => Date.now(),
		});

	const slashCtx: SlashContext = {
		write: (s) => void process.stdout.write(s),
		session: {
			// Wrap newConversation so /new re-binds the tracked id (§1C).
			newConversation: async () => {
				await session.newConversation();
				rename.noteNewConversation();
			},
			status: () =>
				session.status().then((s) => ({ provider: s.provider, model: s.model, effort: s.effort })),
		},
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
		currentSessionId: () => rename.currentSessionId(),
		getSessionTitle: () => rename.getSessionTitle(),
		setSessionTitle: (t) => rename.setSessionTitle(t),
		resume: resumeThunk,
	};
	const slash = new SlashController(slashCtx);

	// On a resume launch, the engine replay is a TTY-only no-op under the
	// self-mount, so surface a one-line notice (after the banner has rendered).
	const notice = resumeNotice(opts.resumeArgs);
	if (notice) process.stdout.write(notice);

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
			keys: replKeys,
			session,
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
		await registry.stop();
	}
	return 0;
}
