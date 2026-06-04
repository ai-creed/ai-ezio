/**
 * Skill discovery (see docs/skills.md).
 *
 * Re-implements hax's SKILL.md discovery in TypeScript so ai-ezio can list and
 * diagnose skills without scraping the engine. Honored directories, highest
 * precedence first:
 *   1. project        <cwd>/.agents/skills/                         (engine-visible)
 *   2. ai-ezio-global  ${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills/  (not yet engine-visible)
 *   3. hax-global      ${XDG_CONFIG_HOME:-$HOME/.config}/hax/skills/      (engine-visible)
 *
 * A skill in a higher row shadows a same-named skill below it. "Engine-visible"
 * means the hax engine itself injects the skill into the model prompt; the
 * ai-ezio-global dir is read by ai-ezio tooling only (see docs/skills.md).
 *
 * All filesystem access is injected so discovery is unit-testable without a real
 * filesystem.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type SkillSource = "project" | "ai-ezio-global" | "hax-global";

export interface SkillDir {
	source: SkillSource;
	path: string;
	engineVisible: boolean;
}

export interface Skill {
	name: string;
	description: string | null;
	skillMdPath: string;
	source: SkillSource;
	engineVisible: boolean;
}

export interface SkillEnv {
	cwd: string;
	home: string;
	xdgConfigHome?: string | undefined;
}

/** Minimal filesystem seam (injected in tests; backed by node:fs in production). */
export interface SkillFs {
	isDirectory: (path: string) => boolean;
	/** Subdirectory names directly under `path` (empty if not a directory). */
	listDirs: (path: string) => string[];
	readFile: (path: string) => string | null;
}

function configBase(env: SkillEnv): string {
	return env.xdgConfigHome && env.xdgConfigHome !== ""
		? env.xdgConfigHome
		: join(env.home, ".config");
}

/** The honored skill directories, highest precedence first. */
export function skillDirs(env: SkillEnv): SkillDir[] {
	const base = configBase(env);
	return [
		{ source: "project", path: join(env.cwd, ".agents", "skills"), engineVisible: true },
		{
			source: "ai-ezio-global",
			path: join(base, "ai-ezio", "skills"),
			// Engine-visible as of M4: ai-ezio sets HAX_EXTRA_SKILLS_DIR to this dir
			// on launch, so hax injects these skills into the model prompt.
			engineVisible: true,
		},
		{ source: "hax-global", path: join(base, "hax", "skills"), engineVisible: true },
	];
}

/**
 * Parse the `description:` from a SKILL.md YAML frontmatter block. Mirrors hax's
 * lenient parse: only a leading `---` fenced block is inspected; the value may be
 * single- or double-quoted. Returns null when absent.
 */
export function parseSkillDescription(md: string): string | null {
	const text = md.replace(/^﻿/, "");
	if (!/^---\r?\n/.test(text)) return null;
	const end = text.indexOf("\n---", 4);
	if (end === -1) return null;
	const front = text.slice(text.indexOf("\n") + 1, end);
	for (const raw of front.split(/\r?\n/)) {
		const m = raw.match(/^description:\s*(.*)$/);
		if (m) {
			let value = (m[1] ?? "").trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			return value.length > 0 ? value : null;
		}
	}
	return null;
}

/**
 * Discover skills across all honored directories, applying precedence: the first
 * occurrence of a skill name (scanning directories high → low precedence) wins;
 * same-named skills in lower-precedence dirs are shadowed. Result is sorted by
 * skill name.
 */
export function discoverSkills(env: SkillEnv, fs: SkillFs): Skill[] {
	const byName = new Map<string, Skill>();
	for (const dir of skillDirs(env)) {
		if (!fs.isDirectory(dir.path)) continue;
		for (const name of fs.listDirs(dir.path)) {
			if (byName.has(name)) continue; // shadowed by higher precedence
			const skillMdPath = join(dir.path, name, "SKILL.md");
			const md = fs.readFile(skillMdPath);
			if (md === null) continue; // a dir without SKILL.md is not a skill
			byName.set(name, {
				name,
				description: parseSkillDescription(md),
				skillMdPath,
				source: dir.source,
				engineVisible: dir.engineVisible,
			});
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** node:fs-backed SkillFs for production use. The pure functions above take an
 * injected SkillFs, so unit tests never touch the real filesystem. */
export function nodeSkillFs(): SkillFs {
	return {
		isDirectory: (path: string): boolean => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
		listDirs: (path: string): string[] => {
			try {
				return readdirSync(path, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name);
			} catch {
				return [];
			}
		},
		readFile: (path: string): string | null => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
	};
}
