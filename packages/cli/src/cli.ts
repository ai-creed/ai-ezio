/**
 * `ai-ezio` CLI launcher.
 *
 * M1 scope: a passthrough launcher. Interactive REPL and `-p` one-shot delegate
 * straight to the embedded hax engine (no protocol yet — that is M3/M4). The one
 * ai-ezio-native command is `--version --json`, which reports the ezio version
 * and the pinned hax base commit.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { describeHaxBinary, resolveHaxBinary } from "@ai-ezio/harness";
import { buildDoctorReport, formatDoctorReport } from "./doctor.js";
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
export function runNativeSubcommand(argv: readonly string[]): number {
	const env = currentSkillEnv();
	const fs = nodeSkillFs();

	if (argv[0] === "doctor") {
		const report = buildDoctorReport({
			version: readVersionInfo(),
			hax: describeHaxBinary(),
			dirs: skillDirs(env),
			dirExists: (p) => fs.isDirectory(p),
			skills: discoverSkills(env, fs),
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

/** Run the CLI, returning the process exit code. */
export async function main(argv: string[]): Promise<number> {
	if (wantsVersionJson(argv)) {
		process.stdout.write(`${JSON.stringify(readVersionInfo())}\n`);
		return 0;
	}

	if (isNativeSubcommand(argv)) {
		return runNativeSubcommand(argv);
	}

	let bin: string;
	try {
		bin = resolveHaxBinary();
	} catch (error) {
		process.stderr.write(`ai-ezio: ${(error as Error).message}\n`);
		return 127;
	}
	ensureExecutable(bin);

	return await new Promise<number>((resolve) => {
		const child = spawn(bin, argv, { stdio: "inherit" });
		child.on("error", (error) => {
			process.stderr.write(`ai-ezio: failed to launch hax: ${error.message}\n`);
			resolve(127);
		});
		child.on("exit", (code, signal) => {
			resolve(signal !== null ? 1 : (code ?? 0));
		});
	});
}
