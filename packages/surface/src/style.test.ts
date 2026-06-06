import { describe, expect, it } from "vitest";
import { BOLD, BRIGHT_MAGENTA, CYAN, DIM, ESC, FG_DEFAULT, GREEN, RED, RESET } from "./style.js";

describe("style palette", () => {
	it("ESC is the real escape byte, never empty (M8 regression guard)", () => {
		expect(ESC).toBe("\u001b");
		expect(ESC).not.toBe("");
	});

	it("every color constant begins with a real ESC + CSI", () => {
		for (const code of [RESET, DIM, BOLD, CYAN, RED, GREEN, BRIGHT_MAGENTA, FG_DEFAULT]) {
			expect(code.startsWith("\u001b[")).toBe(true);
		}
	});

	it("uses the ezio-specific SGR numbers", () => {
		expect(CYAN).toBe("\u001b[36m");
		expect(BRIGHT_MAGENTA).toBe("\u001b[95m");
		expect(FG_DEFAULT).toBe("\u001b[39m");
	});
});
