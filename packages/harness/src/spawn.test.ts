import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiEzioGlobalSkillsDir } from "./skills-dir.js";
import { haxSpawnArgs, haxSpawnEnv } from "./spawn.js";

describe("haxSpawnArgs", () => {
	it("passes --mount-mode and the protocol fds", () => {
		const args = haxSpawnArgs();
		expect(args).toContain("--mount-mode");
		expect(args).toContain("--protocol-fd=3");
		expect(args).toContain("--control-fd=4");
	});
});

describe("haxSpawnEnv (launch-path sets HAX_EXTRA_SKILLS_DIR)", () => {
	it("sets HAX_EXTRA_SKILLS_DIR to the ai-ezio-global skills dir", () => {
		const base = { XDG_CONFIG_HOME: "/xdg", FOO: "bar" } as NodeJS.ProcessEnv;
		const env = haxSpawnEnv(base);
		expect(env.HAX_EXTRA_SKILLS_DIR).toBe(join("/xdg", "ai-ezio", "skills"));
		expect(env.HAX_EXTRA_SKILLS_DIR).toBe(aiEzioGlobalSkillsDir(base));
		expect(env.FOO).toBe("bar"); // base env preserved
	});
});

describe("haxSpawnEnv (transcript mirror)", () => {
	it("sets HAX_TRANSCRIPT when a transcriptPath is given", () => {
		const env = haxSpawnEnv({ FOO: "bar" } as NodeJS.ProcessEnv, "/state/transcripts/x.txt");
		expect(env.HAX_TRANSCRIPT).toBe("/state/transcripts/x.txt");
		expect(env.FOO).toBe("bar"); // base env preserved
	});

	it("leaves HAX_TRANSCRIPT unset when no path is given", () => {
		const env = haxSpawnEnv({ FOO: "bar" } as NodeJS.ProcessEnv);
		expect(env.HAX_TRANSCRIPT).toBeUndefined();
	});
});
