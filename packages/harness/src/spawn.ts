/**
 * Spawn the hax engine with the protocol fds wired. Events arrive on fd 3,
 * controls go out on fd 4; stdin/stdout/stderr default to ignored (the protocol,
 * not the TTY, drives a mounted session). The child dies with the parent.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { resolveHaxBinary } from "./resolve-hax.js";
import { aiEzioGlobalSkillsDir } from "./skills-dir.js";

export interface SpawnHaxOptions {
	/** Override the binary path (defaults to the resolver). */
	binary?: string;
	/** Environment for the child (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/** Extra args appended after the protocol flags. */
	args?: string[];
	/** When set, exported to the child as `HAX_TRANSCRIPT` so hax mirrors the
	 * live transcript (the Ctrl+T content, color off) to this file. The caller
	 * owns the path; the harness only wires the env contract. */
	transcriptPath?: string;
}

export interface SpawnedHax {
	child: ChildProcess;
	/** fd 3 — events from hax. */
	eventStream: Readable;
	/** fd 4 — controls to hax. */
	controlStream: Writable;
}

/** The args a mounted hax spawn uses: protocol fds + `--mount-mode` (chrome
 * suppressed) + any extra. Pure, for testability. */
export function haxSpawnArgs(extra: string[] = []): string[] {
	return ["--protocol-fd=3", "--control-fd=4", "--mount-mode", ...extra];
}

/** The child env for a mounted hax spawn: the base env plus
 * `HAX_EXTRA_SKILLS_DIR` (engine-visibility bridge) and, when a `transcriptPath`
 * is given, `HAX_TRANSCRIPT` (the transcript-mirror seam). Pure, for testability. */
export function haxSpawnEnv(
	base: NodeJS.ProcessEnv = process.env,
	transcriptPath?: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, HAX_EXTRA_SKILLS_DIR: aiEzioGlobalSkillsDir(base) };
	if (transcriptPath) env.HAX_TRANSCRIPT = transcriptPath;
	// Engine auto-compaction defaults OFF for a mounted spawn, but an explicit value
	// (e.g. a subagent's HAX_COMPACT_AUTO=1) is preserved — never overridden here.
	if (env.HAX_COMPACT_AUTO === undefined) env.HAX_COMPACT_AUTO = "0";
	return env;
}

export function spawnHax(options: SpawnHaxOptions = {}): SpawnedHax {
	const binary = options.binary ?? resolveHaxBinary();
	const child = spawn(binary, haxSpawnArgs(options.args), {
		// 0,1,2 ignored; 3 = events (hax writes), 4 = controls (hax reads).
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		env: haxSpawnEnv(options.env ?? process.env, options.transcriptPath),
	});
	const eventStream = child.stdio[3] as Readable;
	const controlStream = child.stdio[4] as Writable;
	return { child, eventStream, controlStream };
}
