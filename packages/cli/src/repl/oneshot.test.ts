import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpHost } from "@ai-ezio/mcp-host";
import { runOneShot } from "./standalone-runtime.js";

// Reuse the harness's deterministic fake engine: in "ok" mode each submit echoes
// `ok <text>` as the authoritative handback — no real hax/provider needed.
const FAKE = fileURLToPath(
	new URL("../../../harness/test-fixtures/fake-engine.mjs", import.meta.url),
);
chmodSync(FAKE, 0o755);

describe("runOneShot", () => {
	it("submits the prompt through the unified Session + host and prints the handback", async () => {
		const out: string[] = [];
		const host = createMcpHost({ servers: [], toolPolicy: {}, hostPrivateTools: [] }, { mode: "mounted", cwd: "/repo" });
		const code = await runOneShot("hello", {
			startOptions: { binary: FAKE, env: { ...process.env, FAKE_ENGINE_MODE: "ok" } },
			host,
			out: (s) => out.push(s),
			err: (s) => out.push(`ERR:${s}`),
		});
		expect(code).toBe(0);
		expect(out.join("")).toContain("ok hello");
	}, 10000);
});
