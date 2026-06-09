import { describe, expect, it } from "vitest";
import { checkCompat, compareSemver, MIN_CORTEX } from "./versions.js";

describe("compareSemver", () => {
	it("orders numerically not lexically", () => {
		expect(compareSemver("0.14.2", "0.9.0")).toBeGreaterThan(0);
		expect(compareSemver("0.13.9", "0.14.0")).toBeLessThan(0);
	});
});
describe("checkCompat", () => {
	it("accepts >= minimum", () =>
		expect(checkCompat("cortex", "0.14.2")).toEqual({ state: "compatible" }));
	it("flags below-min with guidance + NO upgrade", () => {
		const r = checkCompat("cortex", "0.10.0");
		expect(r.state).toBe("below-min");
		if (r.state === "below-min") {
			expect(r.min).toBe(MIN_CORTEX);
			expect(r.guide).toContain("npm i -g ai-cortex@latest");
		}
	});
	it("treats unreadable version as unknown", () =>
		expect(checkCompat("whisper", null)).toEqual({ state: "unknown" }));
});
