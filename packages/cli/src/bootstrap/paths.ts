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
