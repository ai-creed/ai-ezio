import { describe, expect, it, vi } from "vitest";
import { McpHost } from "./host.js";
import type { McpClient } from "./mcp-client.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";

function fakeClient(tools: string[], onCall: (tool: string, args: Record<string, unknown>) => void = () => {}): McpClient {
	return {
		listTools: async (): Promise<DelegatedToolDef[]> =>
			tools.map((name) => ({
				name,
				description: name,
				parametersSchema: { type: "object", properties: { worktreePath: { type: "string" } } },
			})),
		callTool: async (tool, args) => {
			onCall(tool, args);
			return { output: "ok", status: "ok" as const };
		},
		close: async () => {},
	};
}

function fakeSession() {
	const registered: DelegatedToolDef[][] = [];
	return {
		session: {
			registerDelegatedTools: (defs: DelegatedToolDef[]) => void registered.push(defs),
			sendToolResult: vi.fn(),
		},
		registered,
	};
}

describe("McpHost host-private tools", () => {
	it("excludes hostPrivateTools from the delegated set but still routes them", async () => {
		const { session, registered } = fakeSession();
		const host = new McpHost({
			mode: "mounted",
			cwd: "/repo",
			servers: [{ name: "cortex", command: "x", args: [] }],
			toolPolicy: {},
			hostPrivateTools: ["cortex__capture_session"],
			connect: async () => fakeClient(["recall_memory", "capture_session"]),
		});
		await host.start(session);

		const advertised = registered.flat().map((d) => d.name);
		expect(advertised).toEqual(["cortex__recall_memory"]);
		expect(advertised).not.toContain("cortex__capture_session");
	});

	it("callHostTool routes to the client, injects cwd, and returns the result", async () => {
		const { session } = fakeSession();
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const host = new McpHost({
			mode: "mounted",
			cwd: "/repo",
			servers: [{ name: "cortex", command: "x", args: [] }],
			toolPolicy: {},
			hostPrivateTools: ["cortex__capture_session"],
			connect: async () => fakeClient(["capture_session"], (tool, args) => calls.push({ tool, args })),
		});
		await host.start(session);

		const res = await host.callHostTool("cortex__capture_session", { sessionId: "s1-0", worktreePath: "/wrong" });
		expect(res).toEqual({ output: "ok", status: "ok" });
		expect(calls).toEqual([{ tool: "capture_session", args: { sessionId: "s1-0", worktreePath: "/repo" } }]);
	});

	it("callHostTool throws on a denied tool and on an unknown tool", async () => {
		const { session } = fakeSession();
		const host = new McpHost({
			mode: "mounted",
			cwd: "/repo",
			servers: [{ name: "cortex", command: "x", args: [] }],
			toolPolicy: { cortex__capture_session: "deny" },
			hostPrivateTools: ["cortex__capture_session"],
			connect: async () => fakeClient(["capture_session"]),
		});
		await host.start(session);
		await expect(host.callHostTool("cortex__capture_session", {})).rejects.toThrow(/blocked by policy/);
		await expect(host.callHostTool("cortex__nope", {})).rejects.toThrow(/unknown host tool/);
	});
});
