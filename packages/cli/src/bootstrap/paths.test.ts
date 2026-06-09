import { describe, expect, it } from "vitest";
import { bridgeSymlinkPath, configDir, markerPath, selectBashProfile } from "./paths.js";

describe("bootstrap paths", () => {
	const env = { HOME: "/home/u" } as NodeJS.ProcessEnv;
	it("derives config dir + marker from mcp-host's configPath", () => {
		expect(configDir(env)).toBe("/home/u/.config/ai-ezio");
		expect(markerPath(env)).toBe("/home/u/.config/ai-ezio/.bootstrapped");
	});
	it("defaults the bridge symlink under XDG_DATA_HOME (fallback ~/.local/share)", () => {
		expect(bridgeSymlinkPath(env)).toBe("/home/u/.local/share/ai-ezio/hax");
		expect(bridgeSymlinkPath({ ...env, XDG_DATA_HOME: "/data" })).toBe("/data/ai-ezio/hax");
	});
});

describe("selectBashProfile (macOS bash must not shadow an existing ~/.profile, finding 4)", () => {
	const has =
		(...present: string[]) =>
		(p: string) =>
			present.includes(p);
	it("picks ~/.profile when it is the only existing profile (does NOT create ~/.bash_profile)", () => {
		expect(selectBashProfile({ home: "/home/u", fileExists: has("/home/u/.profile") })).toBe(
			"/home/u/.profile",
		);
	});
	it("falls back to creating ~/.bash_profile when none exist", () => {
		expect(selectBashProfile({ home: "/home/u", fileExists: () => false })).toBe(
			"/home/u/.bash_profile",
		);
	});
	it("prefers an existing ~/.bash_profile over the others", () => {
		expect(
			selectBashProfile({
				home: "/home/u",
				fileExists: has("/home/u/.bash_profile", "/home/u/.bash_login", "/home/u/.profile"),
			}),
		).toBe("/home/u/.bash_profile");
	});
	it("picks ~/.bash_login when ~/.bash_profile is absent but it and ~/.profile exist", () => {
		expect(
			selectBashProfile({
				home: "/home/u",
				fileExists: has("/home/u/.bash_login", "/home/u/.profile"),
			}),
		).toBe("/home/u/.bash_login");
	});
});
