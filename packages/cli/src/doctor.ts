/**
 * `ai-ezio doctor` — diagnostics for the engine binary and skill directories.
 *
 * The report builder is pure (all inputs injected) so it is unit-testable; the
 * CLI wires real deps and prints `formatDoctorReport`.
 */
import type { HaxResolution } from "@ai-ezio/harness";
import type { Skill, SkillDir } from "./skills.js";
import type { VersionInfo } from "./version.js";

export interface DoctorSkillDir extends SkillDir {
	exists: boolean;
	count: number;
}

export interface DoctorReport {
	version: VersionInfo;
	hax: HaxResolution;
	skillDirs: DoctorSkillDir[];
	skills: Skill[];
	notes: string[];
}

export interface DoctorInputs {
	version: VersionInfo;
	hax: HaxResolution;
	dirs: SkillDir[];
	dirExists: (path: string) => boolean;
	skills: Skill[];
}

export function buildDoctorReport(input: DoctorInputs): DoctorReport {
	const skillDirs: DoctorSkillDir[] = input.dirs.map((d) => ({
		...d,
		exists: input.dirExists(d.path),
		count: input.skills.filter((s) => s.source === d.source).length,
	}));

	const notes: string[] = [];
	if (!input.hax.ok) {
		notes.push(`hax binary NOT found: ${input.hax.error ?? "unknown error"}`);
	}
	const hidden = input.skills.filter((s) => !s.engineVisible);
	for (const s of hidden) {
		notes.push(
			`skill "${s.name}" (${s.source}) is listed but not yet injected into the engine ` +
				`prompt — install it under .agents/skills/ or the hax-global dir to make it ` +
				`engine-visible (see docs/skills.md).`,
		);
	}

	return { version: input.version, hax: input.hax, skillDirs, skills: input.skills, notes };
}

export function formatDoctorReport(r: DoctorReport): string {
	const lines: string[] = [];
	lines.push("ai-ezio doctor");
	lines.push("");
	lines.push(`  ezio version : ${r.version.ezioVersion}`);
	lines.push(`  hax base     : ${r.version.haxBaseCommit}`);
	lines.push("");
	lines.push("engine binary:");
	if (r.hax.ok) {
		lines.push(`  ✓ ${r.hax.path}  (via ${r.hax.source})`);
	} else {
		lines.push(`  ✗ not found`);
		for (const a of r.hax.attempts) lines.push(`      - ${a}`);
	}
	lines.push("");
	lines.push("skill directories (precedence high → low):");
	for (const d of r.skillDirs) {
		const vis = d.engineVisible ? "engine-visible" : "ai-ezio only";
		const state = d.exists ? `${d.count} skill(s)` : "missing";
		lines.push(`  [${d.source}] ${d.path}  (${vis}; ${state})`);
	}
	if (r.notes.length > 0) {
		lines.push("");
		lines.push("notes:");
		for (const n of r.notes) lines.push(`  ! ${n}`);
	}
	return lines.join("\n");
}
