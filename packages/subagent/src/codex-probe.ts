/**
 * Built-in profile seed: discover the codex models the user's login can reach
 * via `codex debug models`, so codex users get working subagent tiers with no
 * config. Gated on codex being usable; an attempted-but-failed probe degrades to
 * an empty seed plus a doctor-visible note, and never throws.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubagentProfile } from "@ai-ezio/harness";

export interface CodexModel {
	slug: string;
	displayName: string;
	visibility: string;
	supportedInApi: boolean;
	priority: number;
}

/** Parse `codex debug models` JSON; keep only list-visible, API-supported models.
 * Returns [] on any malformed/unexpected input (never throws). */
export function parseCodexModels(stdout: string): CodexModel[] {
	let root: unknown;
	try {
		root = JSON.parse(stdout);
	} catch {
		return [];
	}
	const models = (root as { models?: unknown })?.models;
	if (!Array.isArray(models)) return [];
	const out: CodexModel[] = [];
	for (const m of models) {
		const o = m as Record<string, unknown>;
		if (typeof o?.slug !== "string") continue;
		if (o.visibility !== "list" || o.supported_in_api !== true) continue;
		out.push({
			slug: o.slug,
			displayName: typeof o.display_name === "string" ? o.display_name : o.slug,
			visibility: o.visibility,
			supportedInApi: true,
			priority: typeof o.priority === "number" ? o.priority : 0,
		});
	}
	return out;
}

/** True when codex can be invoked: a `codex` binary on PATH AND an auth file. */
function codexUsable(env: NodeJS.ProcessEnv): boolean {
	if (!existsSync(join(env.HOME ?? homedir(), ".codex", "auth.json"))) return false;
	const paths = (env.PATH ?? "").split(":");
	return paths.some((p) => p && existsSync(join(p, "codex")));
}

/** Probe the codex catalog. Returns the parsed models plus, when an *attempted*
 * probe fails or yields garbage, a doctor-visible `note`. The probe is "attempted"
 * when a runner is injected (tests) or when codex looks usable; otherwise it stays
 * quiet (no models, no note). Never throws.
 *
 * Resolution:
 *   - injected `run` (tests): always attempt — capture throws/garbage as a note.
 *   - default path + codex NOT usable: quiet `{ models: [] }` (codex not in play).
 *   - default path + codex usable: shell out; throws/non-zero/garbage -> note.
 */
export function probeCodexModels(
	opts: { run?: () => string | null; env?: NodeJS.ProcessEnv } = {},
): { models: CodexModel[]; note?: string } {
	const env = opts.env ?? process.env;
	const injected = opts.run !== undefined;
	if (!injected && !codexUsable(env)) return { models: [] }; // codex not in play — quiet
	const run =
		opts.run ??
		(() =>
			execFileSync("codex", ["debug", "models"], {
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			}));
	let stdout: string | null;
	try {
		stdout = run();
	} catch (e) {
		return { models: [], note: `codex debug models failed: ${(e as Error).message}` };
	}
	if (stdout === null) return { models: [] }; // runner opted out — quiet
	const models = parseCodexModels(stdout);
	if (models.length === 0 && stdout.trim() !== "") {
		return { models: [], note: "codex debug models returned no usable models (output unparseable or empty catalog)" };
	}
	return { models };
}

/** One codex profile per model slug; cheapest = a /mini/ slug, else highest priority. */
export function seedCodexProfiles(models: CodexModel[]): {
	profiles: Record<string, SubagentProfile>;
	cheapest?: string;
} {
	const profiles: Record<string, SubagentProfile> = {};
	for (const m of models) {
		profiles[m.slug] = { provider: "codex", model: m.slug, label: m.displayName };
	}
	let cheapest: string | undefined;
	const mini = models.find((m) => /mini/i.test(m.slug));
	if (mini) cheapest = mini.slug;
	else if (models.length) {
		cheapest = models.reduce((a, b) => (b.priority > a.priority ? b : a)).slug;
	}
	return { profiles, cheapest };
}
