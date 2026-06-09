import { describe, expect, it } from "vitest";
import { bridgeSymlinkPath, configDir, markerPath } from "./paths.js";

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
