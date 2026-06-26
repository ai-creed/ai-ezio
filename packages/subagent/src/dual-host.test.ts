/** Integration: MCP host + SubagentHost fan — MCP must stay silent on the
 * subagent tool call so the subagent's reply wins (not a bogus "unknown tool"
 * error). Covers the race fixed in packages/mcp-host/src/host.ts. */
import { expect, it } from "vitest";
import { McpHost } from "@ai-ezio/mcp-host";
import { SubagentHost } from "./host.js";
import { buildCatalog } from "./catalog.js";

it("MCP host stays silent on the subagent tool call so the subagent's reply wins", async () => {
	const results: Array<[string, string, string]> = [];
	const session = {
		registerDelegatedTools: () => {},
		sendToolResult: (id: string, out: string, st: string) => results.push([id, out, st]),
	};

	// Real MCP host with no servers — registers nothing, routes nothing.
	const mcp = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		servers: [],
		toolPolicy: {},
		hostPrivateTools: [],
	});
	await mcp.start(session as never);

	// Real subagent host with one profile and an injected dispatch (no child hax).
	const catalog = buildCatalog({
		config: {
			default: "p",
			subagentTimeoutMs: 1000,
			profiles: { p: { provider: "codex", model: "m" } },
		},
		seed: { profiles: {}, cheapest: undefined },
	});
	const subagentHost = new SubagentHost({
		catalog,
		cwd: "/repo",
		parentEnv: {},
		dispatch: (() => ({
			promise: Promise.resolve({ output: "ANSWER", status: "ok" as const, elapsedMs: 1 }),
			cancel: () => {},
		})) as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	subagentHost.start(session as never);

	const req = {
		type: "tool_call_requested" as const,
		turnId: "t",
		callId: "c1",
		name: "subagent",
		args: { task: "go", profile: "p" },
	};

	// Fan to BOTH, exactly as the CLI's onEvent tee does.
	await Promise.all([mcp.handleEvent(req as never), subagentHost.handleEvent(req as never)]);

	// Exactly one reply — the subagent's, not a bogus "unknown tool" error.
	expect(results).toEqual([["c1", "ANSWER", "ok"]]);
	expect(results.some(([, out]) => /unknown tool/i.test(out))).toBe(false);
});
