import { describe, expect, it } from "vitest";
import { buildDoctorReport, formatDoctorReport, type DoctorInputs } from "./doctor.js";
import { skillDirs, type Skill, type SkillEnv } from "./skills.js";

const ENV: SkillEnv = { cwd: "/proj", home: "/home/u", xdgConfigHome: undefined };

const SKILLS: Skill[] = [
	{
		name: "alpha",
		description: "A",
		skillMdPath: "/proj/.agents/skills/alpha/SKILL.md",
		source: "project",
		engineVisible: true,
	},
	{
		name: "beta",
		description: "B",
		skillMdPath: "/home/u/.config/ai-ezio/skills/beta/SKILL.md",
		source: "ai-ezio-global",
		engineVisible: false,
	},
];

function inputs(over: Partial<DoctorInputs> = {}): DoctorInputs {
	return {
		version: { ezioVersion: "0.1.0", haxBaseCommit: "8fd139b" },
		hax: { ok: true, path: "/store/hax", source: "platform-package", attempts: [] },
		dirs: skillDirs(ENV),
		dirExists: (p) => p === "/proj/.agents/skills",
		skills: SKILLS,
		...over,
	};
}

describe("buildDoctorReport", () => {
	it("counts skills per directory and marks existence", () => {
		const r = buildDoctorReport(inputs());
		const project = r.skillDirs.find((d) => d.source === "project");
		expect(project).toMatchObject({ exists: true, count: 1 });
		expect(r.skillDirs.find((d) => d.source === "hax-global")).toMatchObject({
			exists: false,
			count: 0,
		});
	});

	it("notes non-engine-visible skills", () => {
		const r = buildDoctorReport(inputs());
		expect(r.notes.some((n) => n.includes('"beta"') && n.includes("ai-ezio-global"))).toBe(true);
	});

	it("notes a missing hax binary", () => {
		const r = buildDoctorReport(
			inputs({
				hax: { ok: false, attempts: ["a", "b"], error: "Could not locate the hax binary." },
				skills: [],
			}),
		);
		expect(r.notes.some((n) => n.startsWith("hax binary NOT found"))).toBe(true);
	});
});

describe("formatDoctorReport", () => {
	it("renders the binary source and dir lines", () => {
		const text = formatDoctorReport(buildDoctorReport(inputs()));
		expect(text).toContain("via platform-package");
		expect(text).toContain("[project] /proj/.agents/skills");
		expect(text).toContain("ai-ezio only");
	});
});
