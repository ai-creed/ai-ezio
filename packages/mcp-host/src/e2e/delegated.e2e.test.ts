import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveHaxBinary, Session } from "@ai-ezio/harness";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createMcpHost } from "../attach.js";

function haxBinary(): string | undefined {
	// Prefer the freshly-built dev engine (has the M9 seam) over any stale
	// prebuilt platform-package binary the resolver might pick first.
	const dev = fileURLToPath(new URL("../../../../vendor/hax/build/hax", import.meta.url));
	if (existsSync(dev)) return dev;
	try {
		const bin = resolveHaxBinary();
		return existsSync(bin) ? bin : undefined;
	} catch {
		return undefined;
	}
}

const STUB = fileURLToPath(new URL("./stub-mcp-server.mjs", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./mock-script.txt", import.meta.url));
const bin = haxBinary();

describe.skipIf(!bin)("M9 delegated round-trip (real hax + stub MCP server)", () => {
	it("the model calls a delegated tool and gets the host's result", async () => {
		const events: ProtocolEvent[] = [];
		const host = createMcpHost(
			{ servers: [{ name: "stub", command: process.execPath, args: [STUB] }], toolPolicy: {}, hostPrivateTools: [] },
			{ mode: "mounted", cwd: process.cwd() },
		);
		// onEvent tees every event to BOTH the collector and the host (which services
		// tool_call_requested by calling the stub and replying with sendToolResult).
		const session = new Session({
			onEvent: (e) => {
				events.push(e);
				void host.handleEvent(e);
			},
		});

		await session.start({
			binary: bin,
			env: { ...process.env, HAX_PROVIDER: "mock", HAX_MODEL: "mock", HAX_MOCK_SCRIPT: SCRIPT },
		});

		await host.start(session); // register delegated tools BEFORE the first submit
		const result = await session.submitAndWait("go");

		const finished = events.find((e) => e.type === "tool_call_finished" && e.name === "stub__echo");
		expect(finished).toBeDefined();
		if (finished && finished.type === "tool_call_finished") {
			expect(finished.status).toBe("ok");
			expect(finished.output ?? "").toContain("hi"); // echoed arg routed through the host
		}
		expect(result.content).toContain("done");

		await host.stop();
		session.close();
	}, 15000);
});
