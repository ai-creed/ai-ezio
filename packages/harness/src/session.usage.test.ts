import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Session } from "./session.js";

// The fake engine emits assistant_turn_finished WITH a usage object when FAKE_USAGE
// is set (backward-compatible — omitted by default). FAKE_ENGINE_MODE=normal runs a
// plain turn on the first submit.
const FAKE = fileURLToPath(new URL("../test-fixtures/fake-engine.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

describe("Session.submitAndWait usage", () => {
	it("returns the turn's usage from assistant_turn_finished", async () => {
		const session = new Session();
		await session.start({
			binary: FAKE,
			env: {
				...process.env,
				FAKE_ENGINE_MODE: "normal",
				FAKE_USAGE: JSON.stringify({ outputTokens: 7 }),
			},
		});
		const r = await session.submitAndWait("hi");
		expect(r.content).toBe("ok hi");
		expect(r.usage).toEqual({ outputTokens: 7 });
		session.close();
	}, 10000);

	it("usage is undefined when the engine reports none", async () => {
		const session = new Session();
		await session.start({ binary: FAKE, env: { ...process.env, FAKE_ENGINE_MODE: "normal" } });
		const r = await session.submitAndWait("hi");
		expect(r.usage).toBeUndefined();
		session.close();
	}, 10000);
});
