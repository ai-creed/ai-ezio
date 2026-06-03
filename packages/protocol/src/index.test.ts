import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, isProtocolCompatible, semverMajor } from "./index.js";

describe("protocol version", () => {
	it("exposes a semver version string", () => {
		expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("extracts the major component", () => {
		expect(semverMajor("0.1.0")).toBe(0);
		expect(semverMajor("3.4.5")).toBe(3);
	});

	it("throws on a malformed version", () => {
		expect(() => semverMajor("not-a-version")).toThrow();
	});

	it("treats same-major as compatible and different-major as not", () => {
		expect(isProtocolCompatible("0.9.0", "0.1.0")).toBe(true);
		expect(isProtocolCompatible("1.0.0", "0.1.0")).toBe(false);
	});
});
