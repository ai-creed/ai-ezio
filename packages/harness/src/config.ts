/**
 * General ezio settings: `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/config.json`
 * (sibling of mcp.json, which stays MCP-only and is owned by mcp-host). fs +
 * JSON only — no mcp-host dependency. Missing file or section = defaults;
 * out-of-range values clamp with a doctor-visible note.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CompactionConfig {
	/** Opt-out switch for the auto trigger (spec: default on). */
	auto: boolean;
	/** Fullness ratio (contextTokens / contextLimit) arming auto-compact. */
	threshold: number;
	/** Verbatim tail size kept by a compaction. */
	keepLastTurns: number;
	/** Cortex enrichment; ignored when no rehydrate callback is wired. */
	rehydrate: boolean;
}

export interface EzioConfig {
	compaction: CompactionConfig;
	/** Clamp/parse notes for `doctor`. Empty when the file was clean. */
	notes: string[];
}

export const COMPACTION_DEFAULTS: CompactionConfig = {
	auto: true,
	threshold: 0.8,
	keepLastTurns: 2,
	rehydrate: true,
};

/** `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/config.json` — matches the
 * skills-dir and mcp.json convention. */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME ?? "", ".config");
	return join(base, "ai-ezio", "config.json");
}

function clamp(n: number, lo: number, hi: number, name: string, notes: string[]): number {
	if (n < lo || n > hi) {
		notes.push(`compaction.${name} ${n} out of [${lo}, ${hi}] — clamped`);
		return Math.min(hi, Math.max(lo, n));
	}
	return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EzioConfig {
	const notes: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configFilePath(env), "utf8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			notes.push(`config.json unreadable (${(e as Error).message}) — using defaults`);
		}
		return { compaction: { ...COMPACTION_DEFAULTS }, notes };
	}
	const section = (raw as Record<string, unknown> | null)?.compaction as
		| Partial<Record<keyof CompactionConfig, unknown>>
		| undefined;
	const c = { ...COMPACTION_DEFAULTS };
	if (section && typeof section === "object") {
		if (typeof section.auto === "boolean") c.auto = section.auto;
		if (typeof section.threshold === "number") {
			c.threshold = clamp(section.threshold, 0.3, 0.95, "threshold", notes);
		}
		if (typeof section.keepLastTurns === "number") {
			c.keepLastTurns = Math.round(clamp(section.keepLastTurns, 0, 10, "keepLastTurns", notes));
		}
		if (typeof section.rehydrate === "boolean") c.rehydrate = section.rehydrate;
	}
	return { compaction: c, notes };
}
