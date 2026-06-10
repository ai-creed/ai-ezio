import { describe, expect, it } from "vitest";
import {
	isMountInvocation,
	isNativeSubcommand,
	launchEnv,
	mountStdio,
	wantsVersionJson,
} from "./cli.js";
import { readVersionInfo } from "./version.js";

describe("wantsVersionJson", () => {
	it("is true only when both --version and --json are present", () => {
		expect(wantsVersionJson(["--version", "--json"])).toBe(true);
		expect(wantsVersionJson(["--json", "--version"])).toBe(true);
		expect(wantsVersionJson(["--version"])).toBe(false);
		expect(wantsVersionJson(["-p", "hello"])).toBe(false);
		expect(wantsVersionJson([])).toBe(false);
	});
});

describe("isNativeSubcommand", () => {
	it("intercepts skill and doctor, passes everything else to hax", () => {
		expect(isNativeSubcommand(["skill", "list"])).toBe(true);
		expect(isNativeSubcommand(["doctor"])).toBe(true);
		expect(isNativeSubcommand(["-p", "hi"])).toBe(false);
		expect(isNativeSubcommand([])).toBe(false);
	});
});

describe("isMountInvocation", () => {
	it("detects --mount-mode and protocol fds", () => {
		expect(isMountInvocation(["--mount-mode"])).toBe(true);
		expect(isMountInvocation(["--protocol-fd=3", "--control-fd=4"])).toBe(true);
		expect(isMountInvocation(["-p", "hi"])).toBe(false);
		expect(isMountInvocation([])).toBe(false);
	});
});

describe("mountStdio", () => {
	it("inherits 0/1/2 plus exactly the named protocol fds", () => {
		const s = mountStdio(["--mount-mode", "--protocol-fd=3", "--control-fd=4"]);
		expect(s.length).toBe(5);
		expect(s[0]).toBe("inherit");
		expect(s[3]).toBe("inherit"); // protocol fd forwarded
		expect(s[4]).toBe("inherit"); // control fd forwarded
	});
});

describe("launchEnv (CLI sets HAX_EXTRA_SKILLS_DIR)", () => {
	it("adds HAX_EXTRA_SKILLS_DIR to the child env", () => {
		const env = launchEnv({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv);
		expect(env.HAX_EXTRA_SKILLS_DIR).toBe("/xdg/ai-ezio/skills");
	});
});

describe("readVersionInfo", () => {
	it("reports the ezio version and the pinned hax base commit", () => {
		const info = readVersionInfo();
		expect(info.ezioVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/); // allow prerelease (e.g. 0.1.0-beta.0)
		expect(info.haxBaseCommit).toBe("2d98651a617ad520b7d8b4da46c185b54b8f190c");
	});
});
