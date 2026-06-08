/**
 * Platform clipboard write for /copy. Best-effort: on darwin uses `pbcopy`; on
 * linux tries `wl-copy` (Wayland) then `xclip` (X11). Rejects when no tool is
 * available or a tool errors, so /copy can surface "clipboard unavailable". The
 * spawn function is injected so tests assert the argv without shelling out.
 */
import { spawn } from "node:child_process";

export type SpawnFn = typeof spawn;

/** Run one clipboard tool, piping `text` to its stdin. Resolves on exit 0. */
function tryCopy(argv: string[], text: string, spawnFn: SpawnFn): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawnFn(argv[0]!, argv.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
		child.on("error", reject); // ENOENT when the tool isn't installed
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${argv[0]} exited ${code}`)),
		);
		child.stdin?.end(text);
	});
}

/** Build a clipboard fn for `platform`. Tries candidates in order, rejecting
 * with the last error only when all fail. */
export function makeClipboard(platform: NodeJS.Platform, spawnFn: SpawnFn = spawn) {
	const candidates: string[][] =
		platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
	return async (text: string): Promise<void> => {
		let lastErr: Error = new Error("no clipboard tool available");
		for (const argv of candidates) {
			try {
				await tryCopy(argv, text, spawnFn);
				return;
			} catch (e) {
				lastErr = e as Error;
			}
		}
		throw lastErr;
	};
}
