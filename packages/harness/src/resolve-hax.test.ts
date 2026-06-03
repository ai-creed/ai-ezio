import { describe, expect, it } from "vitest";
import { HaxBinaryNotFoundError, platformPackageName, resolveHaxBinary } from "./resolve-hax.js";

const PLATFORM = "darwin";
const ARCH = "arm64";

describe("platformPackageName", () => {
	it("builds the per-platform package name", () => {
		expect(platformPackageName("linux", "x64")).toBe("@ai-ezio/hax-linux-x64");
	});
});

describe("resolveHaxBinary", () => {
	it("branch 1: returns AI_EZIO_HAX_BIN when it points at an existing file", () => {
		const bin = resolveHaxBinary({
			env: { AI_EZIO_HAX_BIN: "/opt/hax" },
			platform: PLATFORM,
			arch: ARCH,
			fileExists: (p) => p === "/opt/hax",
		});
		expect(bin).toBe("/opt/hax");
	});

	it("branch 1: throws when AI_EZIO_HAX_BIN points at a missing file", () => {
		expect(() =>
			resolveHaxBinary({
				env: { AI_EZIO_HAX_BIN: "/nope/hax" },
				platform: PLATFORM,
				arch: ARCH,
				fileExists: () => false,
			}),
		).toThrow(HaxBinaryNotFoundError);
	});

	it("branch 2: resolves the matching platform package binary", () => {
		const bin = resolveHaxBinary({
			env: {},
			platform: PLATFORM,
			arch: ARCH,
			resolvePackageJson: (spec) => {
				expect(spec).toBe("@ai-ezio/hax-darwin-arm64/package.json");
				return "/store/@ai-ezio/hax-darwin-arm64/package.json";
			},
			fileExists: (p) => p === "/store/@ai-ezio/hax-darwin-arm64/bin/hax",
			devRoot: undefined,
		});
		expect(bin).toBe("/store/@ai-ezio/hax-darwin-arm64/bin/hax");
	});

	it("branch 3: falls back to vendor/hax/build/hax in dev", () => {
		const bin = resolveHaxBinary({
			env: {},
			platform: PLATFORM,
			arch: ARCH,
			resolvePackageJson: () => {
				throw new Error("MODULE_NOT_FOUND");
			},
			devRoot: "/repo",
			fileExists: (p) => p === "/repo/vendor/hax/build/hax",
		});
		expect(bin).toBe("/repo/vendor/hax/build/hax");
	});

	it("miss: throws HaxBinaryNotFoundError when nothing resolves", () => {
		expect(() =>
			resolveHaxBinary({
				env: {},
				platform: PLATFORM,
				arch: ARCH,
				resolvePackageJson: () => {
					throw new Error("MODULE_NOT_FOUND");
				},
				devRoot: undefined,
				fileExists: () => false,
			}),
		).toThrow(/Could not locate the hax binary/);
	});
});
