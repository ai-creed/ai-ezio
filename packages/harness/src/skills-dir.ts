/**
 * The ai-ezio-global skills directory — `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills`.
 * One source of truth shared by both launch paths (the harness `spawnHax` and the
 * CLI), which set `HAX_EXTRA_SKILLS_DIR` to it so ezio's own skills reach the
 * model (see docs/skills.md). Matches the M2 skill-dir resolution.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function aiEzioGlobalSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
	const base =
		env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ""
			? env.XDG_CONFIG_HOME
			: join(homedir(), ".config");
	return join(base, "ai-ezio", "skills");
}
