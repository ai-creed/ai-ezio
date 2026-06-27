import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOneShot } from "./standalone-runtime.js";

// Reuse the harness's deterministic fake engine: in "ok" mode each submit echoes
// `ok <text>` as the authoritative handback — no real hax/provider needed.
const FAKE = fileURLToPath(
	new URL("../../../harness/test-fixtures/fake-engine.mjs", import.meta.url),
);
chmodSync(FAKE, 0o755);

// The wired-in session recorder writes under ezioStateDir() ($XDG_STATE_HOME/ezio);
// redirect it to a temp dir so the test never touches the real home state tree.
let prevStateHome: string | undefined;
beforeAll(() => {
	prevStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "ezio-oneshot-state-"));
});
afterAll(() => {
	if (prevStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = prevStateHome;
});

describe("runOneShot", () => {
	it("submits the prompt through the unified Session + registry and prints the handback", async () => {
		const out: string[] = [];
		const code = await runOneShot("hello", {
			startOptions: { binary: FAKE, env: { ...process.env, FAKE_ENGINE_MODE: "ok" } },
			out: (s) => out.push(s),
			err: (s) => out.push(`ERR:${s}`),
		});
		expect(code).toBe(0);
		expect(out.join("")).toContain("ok hello");
	}, 10000);
});
