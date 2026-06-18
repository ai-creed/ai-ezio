/**
 * The interactive resume picker now lives in @ai-ezio/surface (so the ai-whisper
 * adapter can import it). This module re-exports it and keeps the impure
 * `spawnListSessions` (child_process) that surface deliberately does not own.
 */
import { spawn } from "node:child_process";

export * from "@ai-ezio/surface";

/** Spawn `hax --list-sessions` in `cwd` and resolve its stdout (the JSON array).
 * Resolves "[]" on a non-zero exit or spawn error so the picker degrades to
 * "no sessions" rather than throwing. */
export function spawnListSessions(binary: string, cwd: string): Promise<string> {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(binary, ["--list-sessions"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
		child.stdout?.on("data", (d: Buffer) => void (out += d.toString("utf8")));
		child.on("error", () => resolve("[]"));
		child.on("exit", (code) => resolve(code === 0 ? out : "[]"));
	});
}
