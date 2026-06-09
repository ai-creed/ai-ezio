import { describe, expect, it, vi } from "vitest";
import { isBootstrapped, writeMarker } from "./marker.js";
const env = { HOME: "/home/u" } as NodeJS.ProcessEnv;
describe("marker", () => {
	it("true only when the marker exists", () => {
		expect(isBootstrapped(env, (p) => p === "/home/u/.config/ai-ezio/.bootstrapped")).toBe(true);
		expect(isBootstrapped(env, () => false)).toBe(false);
	});
	it("writes the marker, creating its dir", () => {
		const mkdir = vi.fn();
		const write = vi.fn();
		writeMarker(env, { mkdirp: mkdir, writeFile: write });
		expect(mkdir).toHaveBeenCalledWith("/home/u/.config/ai-ezio");
		expect(write).toHaveBeenCalledWith("/home/u/.config/ai-ezio/.bootstrapped", expect.any(String));
	});
});
