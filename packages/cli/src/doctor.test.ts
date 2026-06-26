import { describe, expect, it } from "vitest";
import { buildDoctorReport, formatDoctorReport, type DoctorInputs } from "./doctor.js";
import { skillDirs, type Skill, type SkillEnv } from "@ai-ezio/surface";

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
		expect(text).toContain("[ai-ezio-global]"); // listed (engine-visible as of M4)
	});

	it("renders bootstrap/wired state and the reconfigure pointer", () => {
		const r = buildDoctorReport({
			version: { ezioVersion: "0.1.0", haxBaseCommit: "x" },
			hax: { ok: true, path: "/hax", source: "platform-package", attempts: [] },
			dirs: [],
			dirExists: () => false,
			skills: [],
			wired: {
				cortexConfigured: true,
				bridgePersisted: false,
				peers: { cortex: true, whisper: false },
			},
		});
		const t = formatDoctorReport(r);
		expect(t).toContain("bootstrap:");
		expect(t).toContain("cortex mcp entry");
		expect(t).toContain("AI_EZIO_HAX_BIN bridge persisted");
		expect(t).toContain("ai-ezio init --reconfigure");
	});
});

describe("doctor compaction diagnostics (M11)", () => {
	it("surfaces config clamp notes and the auto-arming hint", () => {
		const r = buildDoctorReport({
			...inputs(),
			compaction: {
				auto: true,
				configNotes: ["compaction.threshold 2 out of [0.3, 0.95] — clamped"],
				contextLimitEnv: false,
			},
		});
		expect(r.notes.some((n) => n.includes("threshold 2 out of"))).toBe(true);
		expect(r.notes.some((n) => n.includes("auto-compact arms only"))).toBe(true);
	});

	it("no arming hint when auto is off or a limit override exists", () => {
		const off = buildDoctorReport({
			...inputs(),
			compaction: { auto: false, configNotes: [], contextLimitEnv: false },
		});
		expect(off.notes.some((n) => n.includes("auto-compact"))).toBe(false);
		const forced = buildDoctorReport({
			...inputs(),
			compaction: { auto: true, configNotes: [], contextLimitEnv: true },
		});
		expect(forced.notes.some((n) => n.includes("auto-compact"))).toBe(false);
	});
});

describe("doctor subagent diagnostics", () => {
	it("includes subagent codex-probe notes in the report", () => {
		const report = buildDoctorReport({
			version: { ezioVersion: "0", haxBaseCommit: "x" } as never,
			hax: { ok: true, path: "/hax", source: "env", attempts: [] } as never,
			dirs: [],
			dirExists: () => false,
			skills: [],
			subagents: {
				configNotes: [
					"codex debug models returned no usable models (output unparseable or empty catalog)",
				],
			},
		});
		expect(report.notes.some((n) => /codex debug models/.test(n))).toBe(true);
	});
});
