/** MCP host config: `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/mcp.json`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ToolPolicy = "allow" | "deny" | "confirm";

export interface ServerConfig {
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface HostConfig {
	servers: ServerConfig[];
	toolPolicy: Record<string, ToolPolicy>;
	hostPrivateTools: string[];
}

/** `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/mcp.json` — matches the skills-dir convention. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME ?? "", ".config");
	return join(base, "ai-ezio", "mcp.json");
}

export function parseConfig(text: string | undefined): HostConfig {
	if (!text || !text.trim()) return { servers: [], toolPolicy: {}, hostPrivateTools: [] };
	const raw = JSON.parse(text) as {
		mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
		toolPolicy?: Record<string, ToolPolicy>;
		hostPrivateTools?: string[];
	};
	const servers: ServerConfig[] = Object.entries(raw.mcpServers ?? {}).map(([name, s]) => ({
		name,
		command: s.command,
		args: s.args ?? [],
		env: s.env,
	}));
	return { servers, toolPolicy: raw.toolPolicy ?? {}, hostPrivateTools: raw.hostPrivateTools ?? [] };
}

/** Load from disk; returns the empty config if the file is absent or unreadable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
	try {
		return parseConfig(readFileSync(configPath(env), "utf8"));
	} catch {
		return { servers: [], toolPolicy: {}, hostPrivateTools: [] };
	}
}
