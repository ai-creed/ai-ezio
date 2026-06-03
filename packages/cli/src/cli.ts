/**
 * `ai-ezio` CLI launcher.
 *
 * M1 scope: a passthrough launcher. Interactive REPL and `-p` one-shot delegate
 * straight to the embedded hax engine (no protocol yet — that is M3/M4). The one
 * ai-ezio-native command is `--version --json`, which reports the ezio version
 * and the pinned hax base commit.
 */
import { spawn } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveHaxBinary } from "@ai-ezio/harness";

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

interface CliPackageMeta {
	version: string;
	haxBaseCommit?: string;
}

export interface VersionInfo {
	ezioVersion: string;
	haxBaseCommit: string;
}

/** Read ezio version + pinned hax base commit from this package's package.json. */
export function readVersionInfo(): VersionInfo {
	const require = createRequire(import.meta.url);
	const pkg = require("../package.json") as CliPackageMeta;
	return {
		ezioVersion: pkg.version,
		haxBaseCommit: pkg.haxBaseCommit ?? "unknown",
	};
}

/** `--version --json` is the only ezio-native invocation in M1. */
export function wantsVersionJson(argv: readonly string[]): boolean {
	return argv.includes("--version") && argv.includes("--json");
}

/** Run the CLI, returning the process exit code. */
export async function main(argv: string[]): Promise<number> {
	if (wantsVersionJson(argv)) {
		process.stdout.write(`${JSON.stringify(readVersionInfo())}\n`);
		return 0;
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
