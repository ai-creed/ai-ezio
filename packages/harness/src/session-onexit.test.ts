import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Session } from "./session.js";

// The deterministic fake engine emits `ready` then exits ~10ms later under the
// `exit-after-ready` mode, so start() resolves first and the child-exit fires
// onExit afterwards.
const FAKE = fileURLToPath(new URL("../test-fixtures/fake-engine.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

describe("Session.onExit", () => {
	it("invokes registered handlers when the engine child exits", async () => {
		const session = new Session();
		const seen: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
		session.onExit((info) => seen.push(info));

		await session.start({
			binary: FAKE,
			env: { ...process.env, FAKE_ENGINE_MODE: "exit-after-ready" },
		});

		await new Promise((r) => setTimeout(r, 300));
		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(seen[0]).toHaveProperty("code");
		session.close();
	}, 10000);
});
