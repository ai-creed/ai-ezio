/**
 * Pure picker logic tests live in @ai-ezio/surface (packages/surface/src/resume-picker.test.ts).
 * This file covers the cli-only impure piece: spawnListSessions (child_process).
 *
 * spawnListSessions integration tests require a real binary; unit coverage of the
 * happy-path shape is provided by the surface tests via the injected listSessions dep.
 * We simply verify the symbol is re-exported from this module.
 */
import { describe, expect, it } from "vitest";
import { spawnListSessions } from "./resume-picker.js";

describe("spawnListSessions", () => {
	it("is exported as a function", () => {
		expect(typeof spawnListSessions).toBe("function");
	});
});
