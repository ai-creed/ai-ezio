import { describe, expect, it } from "vitest";
import { askYesNo, type PromptIO } from "./prompt.js";
const io = (a: string): PromptIO => ({ ask: async () => a });
describe("askYesNo", () => {
	it("defaults yes on empty", async () => expect(await askYesNo(io(""), "?", true)).toBe(true));
	it("defaults no on empty", async () => expect(await askYesNo(io(""), "?", false)).toBe(false));
	it("honors n / y", async () => {
		expect(await askYesNo(io("n"), "?", true)).toBe(false);
		expect(await askYesNo(io("y"), "?", false)).toBe(true);
	});
});
