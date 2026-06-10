/**
 * `ai-ezio` CLI launcher — the unified entry point.
 *
 * Routes each invocation to the right runtime:
 * - native subcommands `doctor`, `skill list`/`skill dirs`, and `init` (first-run
 *   setup), handled in TS before any hax spawn;
 * - `--version --json` → ezio version + pinned hax base commit;
 * - a bare interactive launch self-mounts (`runStandalone`): hax runs headless and
 *   ezio owns the terminal, with the protocol surface and the generic MCP host;
 * - `-p` one-shot (`runOneShot`) runs a single prompt through the same unified
 *   Session + MCP host;
 * - `--mount-mode` (or inherited protocol fds) forwards the fds for machine-driven
 *   mounted use.
 * Unrecognized argv falls through to raw-hax TUI passthrough (see backlog note in
 * `docs/milestones.md`).
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { aiEzioGlobalSkillsDir, describeHaxBinary, resolveHaxBinary } from "@ai-ezio/harness";
import { buildDoctorReport, formatDoctorReport } from "./doctor.js";
import { runResumePicker, spawnListSessions } from "./repl/resume-picker.js";
import { discoverSkills, nodeSkillFs, skillDirs, type SkillEnv } from "./skills.js";
import { readVersionInfo } from "./version.js";

/** Build the skill-discovery environment from the live process. */
function currentSkillEnv(): SkillEnv {
	return {
		cwd: process.cwd(),
		home: homedir(),
		xdgConfigHome: process.env.XDG_CONFIG_HOME,
	};
}

/** Handle `ai-ezio skill ...` and `ai-ezio doctor`. Returns the exit code. */
export async function runNativeSubcommand(argv: readonly string[]): Promise<number> {
	const env = currentSkillEnv();
	const fs = nodeSkillFs();

	if (argv[0] === "doctor") {
		const { computeWiredState } = await import("./bootstrap/init-cli.js");
		const { loadConfig } = await import("@ai-ezio/harness");
		const ezioConfig = loadConfig();
		const report = buildDoctorReport({
			version: readVersionInfo(),
			hax: describeHaxBinary(),
			dirs: skillDirs(env),
			dirExists: (p) => fs.isDirectory(p),
			skills: discoverSkills(env, fs),
			wired: computeWiredState(),
			compaction: {
				auto: ezioConfig.compaction.auto,
				configNotes: ezioConfig.notes,
				contextLimitEnv: Boolean(process.env.HAX_CONTEXT_LIMIT),
			},
		});
		process.stdout.write(`${formatDoctorReport(report)}\n`);
		return report.hax.ok ? 0 : 1;
	}

	// argv[0] === "skill"
	const sub = argv[1];
	if (sub === "dirs") {
		for (const d of skillDirs(env)) {
			const state = existsSync(d.path) ? "exists" : "missing";
			const vis = d.engineVisible ? "engine-visible" : "ai-ezio only";
			process.stdout.write(`[${d.source}] ${d.path}  (${vis}; ${state})\n`);
		}
		return 0;
	}
	if (sub === "list") {
		const skills = discoverSkills(env, fs);
		if (skills.length === 0) {
			process.stdout.write("no skills found\n");
			return 0;
		}
		for (const s of skills) {
			const vis = s.engineVisible ? "" : " [ai-ezio only]";
			const desc = s.description ? `: ${s.description}` : "";
			process.stdout.write(`${s.name} (${s.source})${vis}${desc}\n`);
		}
		return 0;
	}

	process.stderr.write("usage: ai-ezio skill <list|dirs> | ai-ezio doctor\n");
	return 2;
}

/**
 * npm/pnpm pack normalize file modes and strip the executable bit from files not
 * listed under `bin`, so the embedded hax binary can arrive without `+x`. Restore
 * it before spawning (best-effort; ignore read-only stores). This is the same
 * approach prebuilt-binary packages like esbuild use.
 */
function ensureExecutable(path: string): void {
	try {
		const { mode } = statSync(path);
		if ((mode & 0o111) === 0) {
			chmodSync(path, mode | 0o755);
		}
	} catch {
		// best-effort; if we cannot chmod, the spawn below will surface the error.
	}
}

/** `--version --json` is an ezio-native invocation handled before passthrough. */
export function wantsVersionJson(argv: readonly string[]): boolean {
	return argv.includes("--version") && argv.includes("--json");
}

/** ezio-native subcommands that are intercepted instead of passed to hax. */
export function isNativeSubcommand(argv: readonly string[]): boolean {
	return argv[0] === "skill" || argv[0] === "doctor";
}

/** What a resume invocation asks for. */
export type ResumeIntent =
	| { kind: "continue" } // -c / --continue: newest session in this cwd
	| { kind: "id"; id: string } // --resume=ID: a specific session
	| { kind: "picker" }; // bare --resume / --resume= : choose interactively

/** Parse a resume intent from argv, or undefined when none is present. Recognizes
 * `-c`, `--continue`, `--resume`, and `--resume=ID`; bare `--resume` and an empty
 * `--resume=` both mean "let me choose" (the picker). Pure. */
export function parseResumeIntent(argv: readonly string[]): ResumeIntent | undefined {
	for (const a of argv) {
		if (a === "-c" || a === "--continue") return { kind: "continue" };
		if (a === "--resume") return { kind: "picker" };
		const m = a.match(/^--resume=(.*)$/);
		if (m) return m[1] ? { kind: "id", id: m[1] } : { kind: "picker" };
	}
	return undefined;
}

/** A *bare* resume invocation (argv is exactly one resume token) eligible for the
 * ezio self-mount. Combined invocations (`-p … --continue`, `--mount-mode …`,
 * extra hax flags) return undefined and keep their existing routing. Pure. */
export function resumeSelfMount(argv: readonly string[]): ResumeIntent | undefined {
	if (argv.length !== 1) return undefined;
	return parseResumeIntent(argv);
}

/** The hax args for a resolved resume intent: `continue`/`id` map to a flag the
 * headless spawn forwards; `picker` has none (resolved in TS). Pure. */
export function resumeHaxArgs(intent: ResumeIntent): string[] {
	if (intent.kind === "continue") return ["--continue"];
	if (intent.kind === "id") return [`--resume=${intent.id}`];
	return [];
}

/** Purely informational hax flags whose passthrough should stay quiet (a
 * "running outside the unified stack" note would just be noise on `--help`). */
export function isInformationalPassthrough(argv: readonly string[]): boolean {
	return argv.includes("--help") || argv.includes("-h") || argv.includes("--version");
}

/** A mounted invocation (`--mount-mode` or protocol fds) — forward the fds. */
export function isMountInvocation(argv: readonly string[]): boolean {
	return (
		argv.includes("--mount-mode") ||
		argv.some((a) => a.startsWith("--protocol-fd") || a.startsWith("--control-fd"))
	);
}

/** Build the spawn stdio array for a mounted launch: inherit 0/1/2 plus exactly
 * the fds named by --protocol-fd/--control-fd, so hax gets them. */
export function mountStdio(argv: readonly string[]): Array<"inherit" | "ignore"> {
	const fds = new Set<number>([0, 1, 2]);
	for (const a of argv) {
		const m = a.match(/^--(?:protocol|control)-fd=(\d+)$/);
		if (m?.[1]) fds.add(Number(m[1]));
	}
	const max = Math.max(...fds);
	const stdio: Array<"inherit" | "ignore"> = [];
	for (let i = 0; i <= max; i++) stdio.push(fds.has(i) ? "inherit" : "ignore");
	return stdio;
}

/** Child env for any hax launch: base env + HAX_EXTRA_SKILLS_DIR (so ezio's own
 * skills reach the model on both the human-REPL and mounted paths). */
export function launchEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, HAX_EXTRA_SKILLS_DIR: aiEzioGlobalSkillsDir(base) };
}

/** A bare interactive launch (no args, both ends a TTY) self-mounts: ezio owns
 * the terminal and drives headless hax through the surface + MCP host. */
export function wantsInteractiveSelfMount(argv: readonly string[]): boolean {
	return argv.length === 0 && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** First-run gate predicate (pure; spec §5.2, finding E). */
export function shouldRunFirstRun(
	argv: readonly string[],
	state: { isTTY: boolean; bootstrapped: boolean },
): boolean {
	return argv.length === 0 && state.isTTY && !state.bootstrapped;
}

export interface FirstRunDeps {
	isTTY: () => boolean;
	isBootstrapped: () => boolean;
	runWizard: () => Promise<void>;
}
/** Dispatcher: actually runs the wizard once on a bare interactive launch with
 * no marker. Injectable so the dispatch + run-once suppression is unit-tested. */
export async function maybeRunFirstRun(argv: readonly string[], deps: FirstRunDeps): Promise<void> {
	if (shouldRunFirstRun(argv, { isTTY: deps.isTTY(), bootstrapped: deps.isBootstrapped() })) {
		await deps.runWizard();
	}
}

/** The prompt for a `-p`/`--print <prompt>` one-shot, or undefined when there is
 * no concrete prompt arg (e.g. `-p` reading stdin) — those stay on passthrough. */
export function oneShotPrompt(argv: readonly string[]): string | undefined {
	const i = argv.findIndex((a) => a === "-p" || a === "--print");
	if (i < 0) return undefined;
	const next = argv[i + 1];
	return typeof next === "string" && !next.startsWith("-") ? next : undefined;
}

/** Args to forward to hax for a one-shot (everything except the -p flag + prompt),
 * so e.g. `ezio -p "x" --some-flag` still reaches the engine. */
export function oneShotExtraArgs(argv: readonly string[]): string[] {
	const i = argv.findIndex((a) => a === "-p" || a === "--print");
	if (i < 0) return [];
	return argv.filter((_, idx) => idx !== i && idx !== i + 1);
}

/** Read raw stdin as one string chunk per keypress (escape sequences arrive
 * whole), feeding the resume picker. Iterates with `destroyOnReturn: false` so
 * that when the picker stops consuming (the user selects/cancels) stdin is left
 * ALIVE — the very next consumer is the mounted REPL (`runStandalone`), and a
 * default `for await` would destroy the stream on break and EOF the REPL. */
export async function* stdinChunks(stdin: NodeJS.ReadStream): AsyncGenerator<string> {
	stdin.resume();
	for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
		yield typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
	}
}

/** Hand off to the standalone self-mount with resume args forwarded to hax. */
async function runStandaloneResume(resumeArgs: string[]): Promise<number> {
	const { runStandalone } = await import("./repl/standalone-runtime.js");
	return runStandalone({ resumeArgs });
}

/** Resolve the hax binary, run ezio's session picker (`hax --list-sessions` +
 * a TS-rendered list), and resume the chosen session through the self-mount.
 * A cancel or an empty list exits cleanly without mounting. */
async function resumeViaPicker(): Promise<number> {
	let binary: string;
	try {
		binary = resolveHaxBinary();
	} catch (error) {
		process.stderr.write(`ai-ezio: ${(error as Error).message}\n`);
		return 127;
	}
	ensureExecutable(binary);
	const cwd = process.cwd();
	const id = await runResumePicker({
		listSessions: () => spawnListSessions(binary, cwd),
		keys: stdinChunks(process.stdin),
		write: (s) => void process.stdout.write(s),
		now: () => Date.now(),
		setRawMode: (on) => void process.stdin.setRawMode?.(on),
	});
	if (id === undefined) {
		process.stdout.write("ai-ezio: no session selected.\n");
		return 0;
	}
	return runStandaloneResume([`--resume=${id}`]);
}

/** Run the CLI, returning the process exit code. */
export async function main(argv: string[]): Promise<number> {
	if (wantsVersionJson(argv)) {
		process.stdout.write(`${JSON.stringify(readVersionInfo())}\n`);
		return 0;
	}

	if (isNativeSubcommand(argv)) {
		return await runNativeSubcommand(argv);
	}

	if (argv[0] === "init") {
		const { runInitCli } = await import("./bootstrap/init-cli.js");
		return runInitCli(argv.slice(1));
	}

	if (wantsInteractiveSelfMount(argv)) {
		const [{ existsSync }, { isBootstrapped }] = await Promise.all([
			import("node:fs"),
			import("./bootstrap/marker.js"),
		]);
		await maybeRunFirstRun(argv, {
			isTTY: () => true,
			isBootstrapped: () => isBootstrapped(process.env, existsSync),
			runWizard: async () => {
				// First-run bootstrap is best-effort: ANY failure (incl. an fs EACCES that
				// escaped the per-step guards) must NOT block entry into the REPL (finding
				// 1, §6) — warn and proceed to runStandalone() below.
				try {
					const { runInitCli } = await import("./bootstrap/init-cli.js");
					await runInitCli([]); // default-yes offers; writes the marker; failures non-fatal
				} catch (error) {
					process.stderr.write(
						`ai-ezio: first-run setup did not complete (${(error as Error).message}); continuing. Run \`ai-ezio init\` later to finish.\n`,
					);
				}
			},
		});
		const { runStandalone } = await import("./repl/standalone-runtime.js");
		return runStandalone();
	}

	// `ai-ezio --continue` / `--resume=ID` resumes a prior session through the
	// unified self-mount (MCP host + compactor + surface stay active), instead of
	// silently falling through to the raw-hax TUI passthrough below. Only a bare
	// resume token on a TTY qualifies; combined invocations keep their routing.
	const resume = resumeSelfMount(argv);
	if (resume && process.stdin.isTTY && process.stdout.isTTY) {
		// Bare `--resume` opens ezio's own session picker (hax's picker is a
		// full-screen TUI that cannot run under the headless mount); a resolved
		// `-c`/`--resume=ID` goes straight to the self-mount.
		return resume.kind === "picker"
			? await resumeViaPicker()
			: await runStandaloneResume(resumeHaxArgs(resume));
	}

	// `-p <prompt>` one-shot runs through the unified Session + MCP host
	// (submitAndWait), so a one-shot can use registered MCP tools too.
	const oneShot = oneShotPrompt(argv);
	if (oneShot !== undefined) {
		const { runOneShot } = await import("./repl/standalone-runtime.js");
		return runOneShot(oneShot, { startOptions: { args: oneShotExtraArgs(argv) } });
	}

	let bin: string;
	try {
		bin = resolveHaxBinary();
	} catch (error) {
		process.stderr.write(`ai-ezio: ${(error as Error).message}\n`);
		return 127;
	}
	ensureExecutable(bin);

	// Anything reaching here is raw-hax passthrough — outside the unified
	// architecture (no MCP host, compactor, or ezio surface). Say so loudly rather
	// than silently masquerading as an ezio feature, except for purely
	// informational flags where the note would just be noise.
	if (!isMountInvocation(argv) && !isInformationalPassthrough(argv)) {
		process.stderr.write(
			"ai-ezio: raw hax passthrough — the MCP host, compaction, and ezio surface " +
				"are inactive on this path.\n",
		);
	}

	// Human REPL inherits the terminal; a mounted launch forwards the protocol
	// fds (and --mount-mode) to hax. Both set HAX_EXTRA_SKILLS_DIR.
	const stdio = isMountInvocation(argv) ? mountStdio(argv) : "inherit";
	return await new Promise<number>((resolve) => {
		const child = spawn(bin, argv, { stdio, env: launchEnv() });
		child.on("error", (error) => {
			process.stderr.write(`ai-ezio: failed to launch hax: ${error.message}\n`);
			resolve(127);
		});
		child.on("exit", (code, signal) => {
			resolve(signal !== null ? 1 : (code ?? 0));
		});
	});
}
