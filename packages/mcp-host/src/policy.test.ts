import { describe, expect, it } from "vitest";
import { decidePolicy, DEFAULT_DENY } from "./policy.js";

describe("policy", () => {
	it("denies the default destructive set", () => {
		expect(DEFAULT_DENY).toContain("cortex__purge_memory");
		expect(decidePolicy("cortex__purge_memory", {}, "mounted")).toBe("deny");
	});
	it("allows read-ish tools by default", () => {
		expect(decidePolicy("cortex__recall_memory", {}, "mounted")).toBe("allow");
	});
	it("config overrides defaults", () => {
		expect(
			decidePolicy("cortex__recall_memory", { cortex__recall_memory: "deny" }, "mounted"),
		).toBe("deny");
	});
	it("confirm degrades to deny in mounted, stays confirm in standalone", () => {
		const pol = { cortex__trash_memory: "confirm" as const };
		expect(decidePolicy("cortex__trash_memory", pol, "mounted")).toBe("deny");
		expect(decidePolicy("cortex__trash_memory", pol, "standalone")).toBe("confirm");
	});
});
