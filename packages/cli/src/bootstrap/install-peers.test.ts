import { describe, expect, it, vi } from "vitest";
import { installPeer } from "./install-peers.js";

describe("installPeer", () => {
	it("npm install -g <pkg>", () => {
		const run = vi.fn(() => ({ ok: true }));
		installPeer("npm", "ai-cortex", { run });
		expect(run).toHaveBeenCalledWith("npm", ["install", "-g", "ai-cortex"]);
	});
	it("pnpm add -g <pkg>", () => {
		const run = vi.fn(() => ({ ok: true }));
		installPeer("pnpm", "ai-whisper", { run });
		expect(run).toHaveBeenCalledWith("pnpm", ["add", "-g", "ai-whisper"]);
	});
	it("failed install is non-fatal with stderr", () => {
		expect(
			installPeer("npm", "ai-cortex", { run: () => ({ ok: false, stderr: "EACCES" }) }),
		).toEqual({
			ok: false,
			error: "EACCES",
		});
	});
});
