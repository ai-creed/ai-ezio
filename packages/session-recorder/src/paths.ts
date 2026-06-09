/** Filesystem layout helpers for ezio-owned session artifacts. */
import { join } from "node:path";

/** `$XDG_STATE_HOME/ezio` or `$HOME/.local/state/ezio`. */
export function ezioStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_STATE_HOME?.trim() || join(env.HOME ?? "", ".local", "state");
	return join(base, "ezio");
}

/** A stable, fs-safe grouping key for a repo path (ezio file grouping only; cortex
 * derives its own repoKey internally from worktreePath). */
export function repoKeyForPath(cwd: string): string {
	return (
		cwd
			.replace(/[^\w-]/g, "-")
			.replace(/^-+/, "")
			.slice(0, 200) || "root"
	);
}
