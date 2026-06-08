import { expect, it } from "vitest";
import { createMcpHost } from "./attach.js";
import type { McpClient } from "./mcp-client.js";

it("builds a host from an explicit config and registers tools in mounted mode", async () => {
	const registered: unknown[] = [];
	const session = {
		registerDelegatedTools: (t: unknown) => registered.push(t),
		sendToolResult: () => {},
	};
	const fake: McpClient = {
		listTools: async () => [
			{ name: "recall_memory", description: "", parametersSchema: { type: "object" } },
		],
		callTool: async () => ({ output: "", status: "ok" }),
		close: async () => {},
	};
	const host = createMcpHost(
		{ servers: [{ name: "cortex", command: "x", args: [] }], toolPolicy: {} },
		{ mode: "mounted", cwd: "/repo", connect: async () => fake },
	);
	await host.start(session as never);
	expect((registered[0] as Array<{ name: string }>)[0].name).toBe("cortex__recall_memory");
});

it("builds a no-op host (no servers) when config is empty", async () => {
	const registered: unknown[] = [];
	const session = {
		registerDelegatedTools: (t: unknown) => registered.push(t),
		sendToolResult: () => {},
	};
	const host = createMcpHost({ servers: [], toolPolicy: {} }, { mode: "standalone", cwd: "/repo" });
	await host.start(session as never);
	expect(registered).toEqual([]);
});
