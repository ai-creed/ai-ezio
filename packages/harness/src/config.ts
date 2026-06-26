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

export interface SubagentProfile {
	/** -> HAX_PROVIDER */
	provider: string;
	/** -> HAX_MODEL */
	model: string;
	/** -> HAX_REASONING_EFFORT (optional). */
	effort?: string;
	/** Name of the parent-env var holding this provider's API key (optional;
	 * codex profiles need none). Validated before dispatch, not here. */
	apiKeyEnv?: string;
	/** Name of the parent-env var holding a base URL override (optional). */
	baseUrlEnv?: string;
	/** Hint surfaced to the model in the tool description (optional). */
	label?: string;
}

export interface SubagentsConfig {
	/** Profile used when the model omits `profile`. */
	default?: string;
	/** Per-dispatch budget (ms). */
	subagentTimeoutMs: number;
	/** User profiles; override/extend the built-in codex seed. */
	profiles: Record<string, SubagentProfile>;
}

export const SUBAGENT_TIMEOUT_DEFAULT = 300000;

export interface EzioConfig {
	compaction: CompactionConfig;
	subagents: SubagentsConfig;
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

function parseSubagents(raw: Record<string, unknown> | null, notes: string[]): SubagentsConfig {
	const out: SubagentsConfig = {
		default: undefined,
		subagentTimeoutMs: SUBAGENT_TIMEOUT_DEFAULT,
		profiles: {},
	};
	const section = raw?.subagents as Record<string, unknown> | undefined;
	if (!section || typeof section !== "object") return out;
	if (typeof section.default === "string") out.default = section.default;
	if (typeof section.subagentTimeoutMs === "number" && section.subagentTimeoutMs > 0) {
		out.subagentTimeoutMs = Math.round(section.subagentTimeoutMs);
	} else if (section.subagentTimeoutMs !== undefined) {
		notes.push(`subagents.subagentTimeoutMs invalid — using ${SUBAGENT_TIMEOUT_DEFAULT}`);
	}
	const profiles = section.profiles as Record<string, unknown> | undefined;
	if (profiles && typeof profiles === "object") {
		for (const [name, p] of Object.entries(profiles)) {
			const prof = p as Partial<SubagentProfile>;
			if (typeof prof?.provider !== "string" || typeof prof?.model !== "string") {
				notes.push(`subagents.profiles.${name} missing provider/model — dropped`);
				continue;
			}
			out.profiles[name] = {
				provider: prof.provider,
				model: prof.model,
				...(typeof prof.effort === "string" ? { effort: prof.effort } : {}),
				...(typeof prof.apiKeyEnv === "string" ? { apiKeyEnv: prof.apiKeyEnv } : {}),
				...(typeof prof.baseUrlEnv === "string" ? { baseUrlEnv: prof.baseUrlEnv } : {}),
				...(typeof prof.label === "string" ? { label: prof.label } : {}),
			};
		}
	}
	return out;
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
		return {
			compaction: { ...COMPACTION_DEFAULTS },
			subagents: { default: undefined, subagentTimeoutMs: SUBAGENT_TIMEOUT_DEFAULT, profiles: {} },
			notes,
		};
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
	return {
		compaction: c,
		subagents: parseSubagents(raw as Record<string, unknown> | null, notes),
		notes,
	};
}
