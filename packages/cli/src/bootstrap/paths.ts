/** XDG path helpers. Config paths reuse mcp-host's configPath so ezio's config
 * dir is defined in exactly one place. */
import { dirname, join } from "node:path";
import { configPath } from "@ai-ezio/mcp-host";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	return dirname(configPath(env));
}
export function markerPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configDir(env), ".bootstrapped");
}
export function bridgeSymlinkPath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_DATA_HOME?.trim() || join(env.HOME ?? "", ".local", "share");
	return join(base, "ai-ezio", "hax");
}

/** Which profile a macOS login bash actually sources (finding 4). bash reads the
 * FIRST existing of ~/.bash_profile -> ~/.bash_login -> ~/.profile and stops; if
 * the user only has ~/.profile, creating ~/.bash_profile would silently shadow it
 * (login bash would then never source ~/.profile). So return the first EXISTING
 * file and only fall back to ~/.bash_profile (the canonical create target) when
 * none exist. Pure + injected (home, fileExists) so it is unit-testable. */
export function selectBashProfile(deps: {
	home: string;
	fileExists: (path: string) => boolean;
}): string {
	const fallback = join(deps.home, ".bash_profile"); // canonical create target if none exist
	const candidates = [fallback, join(deps.home, ".bash_login"), join(deps.home, ".profile")];
	return candidates.find(deps.fileExists) ?? fallback;
}
