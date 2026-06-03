/**
 * Spawn the hax engine with the protocol fds wired. Events arrive on fd 3,
 * controls go out on fd 4; stdin/stdout/stderr default to ignored (the protocol,
 * not the TTY, drives a mounted session). The child dies with the parent.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { resolveHaxBinary } from "./resolve-hax.js";

export interface SpawnHaxOptions {
	/** Override the binary path (defaults to the resolver). */
	binary?: string;
	/** Environment for the child (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/** Extra args appended after the protocol flags. */
	args?: string[];
}

export interface SpawnedHax {
	child: ChildProcess;
	/** fd 3 — events from hax. */
	eventStream: Readable;
	/** fd 4 — controls to hax. */
	controlStream: Writable;
}

export function spawnHax(options: SpawnHaxOptions = {}): SpawnedHax {
	const binary = options.binary ?? resolveHaxBinary();
	const child = spawn(binary, ["--protocol-fd=3", "--control-fd=4", ...(options.args ?? [])], {
		// 0,1,2 ignored; 3 = events (hax writes), 4 = controls (hax reads).
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		env: options.env ?? process.env,
	});
	const eventStream = child.stdio[3] as Readable;
	const controlStream = child.stdio[4] as Writable;
	return { child, eventStream, controlStream };
}
