import { describe, expect, it } from "vitest";
import { isNativeSubcommand, wantsVersionJson } from "./cli.js";
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

describe("readVersionInfo", () => {
	it("reports the ezio version and the pinned hax base commit", () => {
		const info = readVersionInfo();
		expect(info.ezioVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(info.haxBaseCommit).toBe("8fd139b5db49bd0b1d552c2530a18b547b3f4f4c");
	});
});
