/** Registry routing: a subagent tool_call_requested is served by the SubagentHost,
 * not by McpHost, so no "unknown tool" error leaks through. */
import { expect, it } from "vitest";
import { DelegatedToolRegistry } from "@ai-ezio/harness";
import { McpHost } from "@ai-ezio/mcp-host";
import { SubagentHost } from "./host.js";
import { buildCatalog } from "./catalog.js";

it("registry routes a subagent call to the subagent host (MCP host never replies 'unknown tool')", async () => {
	const results: Array<[string, string, string]> = [];
	const session = {
		registerDelegatedTools: () => {},
		sendToolResult: (id: string, out: string, st: string) => results.push([id, out, st]),
	};
	const mcp = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		servers: [],
		toolPolicy: {},
		hostPrivateTools: [],
	});
	const subagentHost = new SubagentHost({
		catalog: buildCatalog({
			config: {
				default: "p",
				subagentTimeoutMs: 1000,
				profiles: { p: { provider: "codex", model: "m" } },
			},
			seed: { profiles: {}, cheapest: undefined },
		}),
		cwd: "/repo",
		parentEnv: {},
		dispatch: (() => ({
			promise: Promise.resolve({ output: "ANSWER", status: "ok", elapsedMs: 1 }),
			cancel: () => {},
		})) as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	const reg = new DelegatedToolRegistry([mcp, subagentHost]);
	await reg.start(session);
	reg.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "subagent",
		args: { task: "go", profile: "p" },
	});
	await new Promise((r) => setTimeout(r, 0));
	expect(results).toEqual([["c1", "ANSWER", "ok"]]);
	expect(results.some(([, out]) => /unknown tool/.test(out))).toBe(false);
});
