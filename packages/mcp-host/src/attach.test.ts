import { describe, expect, it, vi } from "vitest";
import { createMcpHost } from "./attach.js";
import { parseConfig } from "./config.js";
import type { McpClient } from "./mcp-client.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";

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
		{ servers: [{ name: "cortex", command: "x", args: [] }], toolPolicy: {}, hostPrivateTools: [] },
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
	const host = createMcpHost(
		{ servers: [], toolPolicy: {}, hostPrivateTools: [] },
		{ mode: "standalone", cwd: "/repo" },
	);
	await host.start(session as never);
	expect(registered).toEqual([]);
});

describe("createMcpHost host-private default", () => {
	it("keeps cortex__capture_session OUT of the delegated set by default", async () => {
		const registered: DelegatedToolDef[][] = [];
		const session = {
			registerDelegatedTools: (d: DelegatedToolDef[]) => void registered.push(d),
			sendToolResult: vi.fn(),
		};
		const client: McpClient = {
			listTools: async () => [
				{ name: "recall_memory", description: "", parametersSchema: { type: "object" } },
				{ name: "capture_session", description: "", parametersSchema: { type: "object" } },
			],
			callTool: async () => ({ output: "", status: "ok" as const }),
			close: async () => {},
		};
		const host = createMcpHost(
			{
				servers: [{ name: "cortex", command: "x", args: [] }],
				toolPolicy: {},
				hostPrivateTools: [],
			},
			{ mode: "mounted", cwd: "/repo", connect: async () => client },
		);
		await host.start(session);

		const advertised = registered.flat().map((d) => d.name);
		expect(advertised).toContain("cortex__recall_memory");
		expect(advertised).not.toContain("cortex__capture_session");
	});

	it("parseConfig carries hostPrivateTools (defaults to [])", () => {
		expect(parseConfig(undefined).hostPrivateTools).toEqual([]);
		expect(parseConfig(JSON.stringify({ hostPrivateTools: ["x__y"] })).hostPrivateTools).toEqual([
			"x__y",
		]);
	});
});
