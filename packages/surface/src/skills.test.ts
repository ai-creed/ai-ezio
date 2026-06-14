import { describe, expect, it } from "vitest";
import {
	discoverSkills,
	parseSkillDescription,
	skillDirs,
	type SkillEnv,
	type SkillFs,
} from "./skills.js";

const ENV: SkillEnv = { cwd: "/proj", home: "/home/u", xdgConfigHome: undefined };

describe("skillDirs", () => {
	it("returns the three honored dirs in precedence order with engine-visibility", () => {
		const dirs = skillDirs(ENV);
		expect(dirs.map((d) => d.source)).toEqual(["project", "ai-ezio-global", "hax-global"]);
		expect(dirs[0]).toMatchObject({ path: "/proj/.agents/skills", engineVisible: true });
		expect(dirs[1]).toMatchObject({
			path: "/home/u/.config/ai-ezio/skills",
			engineVisible: true, // M4: bridged in via HAX_EXTRA_SKILLS_DIR
		});
		expect(dirs[2]).toMatchObject({ path: "/home/u/.config/hax/skills", engineVisible: true });
	});

	it("honors XDG_CONFIG_HOME when set", () => {
		const dirs = skillDirs({ cwd: "/proj", home: "/home/u", xdgConfigHome: "/xdg" });
		expect(dirs[1].path).toBe("/xdg/ai-ezio/skills");
		expect(dirs[2].path).toBe("/xdg/hax/skills");
	});
});

describe("parseSkillDescription", () => {
	it("extracts a quoted description from frontmatter", () => {
		const md = ["---", 'description: "Format code with prettier"', "---", "", "# body"].join("\n");
		expect(parseSkillDescription(md)).toBe("Format code with prettier");
	});

	it("extracts an unquoted description", () => {
		expect(parseSkillDescription("---\ndescription: do a thing\n---\n")).toBe("do a thing");
	});

	it("returns null when there is no frontmatter or no description", () => {
		expect(parseSkillDescription("# just a heading\n")).toBeNull();
		expect(parseSkillDescription("---\nname: x\n---\n")).toBeNull();
	});
});

describe("discoverSkills", () => {
	function fakeFs(tree: Record<string, string[]>, files: Record<string, string>): SkillFs {
		return {
			isDirectory: (p) => p in tree,
			listDirs: (p) => tree[p] ?? [],
			readFile: (p) => files[p] ?? null,
		};
	}

	it("discovers skills across dirs and marks their source + engine-visibility", () => {
		const fs = fakeFs(
			{
				"/proj/.agents/skills": ["alpha"],
				"/home/u/.config/ai-ezio/skills": ["beta"],
				"/home/u/.config/hax/skills": ["gamma"],
			},
			{
				"/proj/.agents/skills/alpha/SKILL.md": "---\ndescription: A\n---\n",
				"/home/u/.config/ai-ezio/skills/beta/SKILL.md": "---\ndescription: B\n---\n",
				"/home/u/.config/hax/skills/gamma/SKILL.md": "# no front",
			},
		);
		const skills = discoverSkills(ENV, fs);
		expect(skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
		expect(skills.find((s) => s.name === "beta")).toMatchObject({
			source: "ai-ezio-global",
			engineVisible: true, // M4: ai-ezio-global is bridged into the prompt
			description: "B",
		});
		expect(skills.find((s) => s.name === "gamma")?.description).toBeNull();
	});

	it("shadows same-named skills by precedence (project wins over globals)", () => {
		const fs = fakeFs(
			{
				"/proj/.agents/skills": ["dup"],
				"/home/u/.config/hax/skills": ["dup"],
			},
			{
				"/proj/.agents/skills/dup/SKILL.md": "---\ndescription: project\n---\n",
				"/home/u/.config/hax/skills/dup/SKILL.md": "---\ndescription: global\n---\n",
			},
		);
		const skills = discoverSkills(ENV, fs);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({ source: "project", description: "project" });
	});

	it("ignores subdirectories without a SKILL.md", () => {
		const fs = fakeFs(
			{ "/proj/.agents/skills": ["notaskill"] },
			{}, // no SKILL.md
		);
		expect(discoverSkills(ENV, fs)).toEqual([]);
	});
});
