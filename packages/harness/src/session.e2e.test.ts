import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Session } from "./session.js";

/** Locate the dev-built hax binary by walking up to the repo root. */
function devHax(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		const bin = join(dir, "vendor", "hax", "build", "hax");
		if (existsSync(bin)) return bin;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

const HAX = devHax();
const env = { ...process.env, HAX_PROVIDER: "mock", HAX_NO_SESSION: "1" };

// Skips cleanly when the engine isn't built (e.g. CI without the submodule).
describe.runIf(Boolean(HAX))("Session e2e over inherited fds (mock provider)", () => {
	it("drives ready -> submit -> authoritative content -> idle", async () => {
		const session = new Session();
		const ready = await session.start({ binary: HAX, env });
		expect(ready.protocol).toMatch(/^\d+\.\d+\.\d+$/);
		expect(ready.haxBaseCommit).toBeTruthy();

		const result = await session.submitAndWait("say hello");
		// authoritative handback from hax's finalized text — not scraped stdout
		expect(result.content).toContain("say hello");

		session.close();
	}, 20000);

	it("handles a second turn (idle is the safe re-submit point)", async () => {
		const session = new Session();
		await session.start({ binary: HAX, env });
		const a = await session.submitAndWait("first");
		const b = await session.submitAndWait("second");
		expect(a.content).toContain("first");
		expect(b.content).toContain("second");
		session.close();
	}, 20000);
});
