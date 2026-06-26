/** The effective profile catalog: built-in codex seed merged with user config. */
import type { SubagentProfile, SubagentsConfig } from "@ai-ezio/harness";

export interface Catalog {
	/** Merged profiles (user wins on name collision). */
	profiles: Record<string, SubagentProfile>;
	/** Resolved default profile name (when the model omits `profile`). */
	default?: string;
	/** Per-dispatch budget (ms). */
	timeoutMs: number;
	/** Profile names, for the tool schema enum. */
	names: string[];
}

export function buildCatalog(args: {
	config: SubagentsConfig;
	seed: { profiles: Record<string, SubagentProfile>; cheapest?: string };
}): Catalog {
	const { config, seed } = args;
	// User profiles override seeded ones by name.
	const profiles: Record<string, SubagentProfile> = { ...seed.profiles, ...config.profiles };
	const names = Object.keys(profiles);
	// Default: explicit user choice, else cheapest seeded, else first profile.
	let def = config.default;
	if (!def || !profiles[def]) def = seed.cheapest && profiles[seed.cheapest] ? seed.cheapest : names[0];
	return { profiles, default: def, timeoutMs: config.subagentTimeoutMs, names };
}
