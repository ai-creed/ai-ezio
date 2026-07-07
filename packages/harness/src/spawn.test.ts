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
		const env = haxSpawnEnv({ FOO: "bar" }, "/state/transcripts/x.txt");
		expect(env.HAX_TRANSCRIPT).toBe("/state/transcripts/x.txt");
		expect(env.FOO).toBe("bar"); // base env preserved
	});

	it("leaves HAX_TRANSCRIPT unset when no path is given", () => {
		const env = haxSpawnEnv({ FOO: "bar" });
		expect(env.HAX_TRANSCRIPT).toBeUndefined();
	});
});

describe("haxSpawnEnv (engine auto-compaction default)", () => {
	it("off-defaults HAX_COMPACT_AUTO to 0 when the base does not set it", () => {
		expect(haxSpawnEnv({}).HAX_COMPACT_AUTO).toBe("0");
	});

	it("preserves an explicit HAX_COMPACT_AUTO and never overrides it", () => {
		expect(haxSpawnEnv({ HAX_COMPACT_AUTO: "1" }).HAX_COMPACT_AUTO).toBe("1");
		expect(haxSpawnEnv({ HAX_COMPACT_AUTO: "0" }).HAX_COMPACT_AUTO).toBe("0");
	});
});
