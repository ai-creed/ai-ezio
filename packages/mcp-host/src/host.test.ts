import { expect, it, vi } from "vitest";
import { McpHost } from "./host.js";
import type { McpClient } from "./mcp-client.js";

// Tools declare a schema (properties) so cwd-injection can be schema-aware.
function fakeClient(
	tools: Array<{ name: string; props?: string[] }>,
	onCall: (
		t: string,
		a: Record<string, unknown>,
	) => { output: string; status: "ok" | "error" } | Promise<never>,
): McpClient {
	return {
		listTools: async () =>
			tools.map((t) => ({
				name: t.name,
				description: "",
				parametersSchema: {
					type: "object",
					properties: Object.fromEntries((t.props ?? []).map((p) => [p, { type: "string" }])),
				},
			})),
		callTool: async (t, a) => onCall(t, a) as { output: string; status: "ok" | "error" },
		close: async () => {},
	};
}

function fakeSession() {
	const registered: unknown[] = [];
	const results: Array<[string, string, string]> = [];
	return {
		registered,
		results,
		session: {
			registerDelegatedTools: (t: unknown) => registered.push(t),
			sendToolResult: (id: string, out: string, st: string) => results.push([id, out, st]),
		},
	};
}

it("registers namespaced tools and routes a call, injecting cwd from schema", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "recall_memory", props: ["query", "worktreePath"] }], (t, a) => ({
				output: `called ${t} ${JSON.stringify(a)}`,
				status: "ok",
			})),
	});
	await host.start(fx.session as never);
	expect((fx.registered[0] as Array<{ name: string }>)[0].name).toBe("cortex__recall_memory");

	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "cortex__recall_memory",
		args: { query: "x" },
	});
	expect(fx.results[0]).toEqual([
		"c1",
		`called recall_memory {"query":"x","worktreePath":"/repo"}`,
		"ok",
	]);
});

it("overrides model-supplied worktreePath AND path (no drift)", async () => {
	const fx = fakeSession();
	let seen: Record<string, unknown> = {};
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "suggest_files", props: ["task", "path", "worktreePath"] }], (_t, a) => {
				seen = a;
				return { output: "ok", status: "ok" };
			}),
	});
	await host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "cortex__suggest_files",
		args: { task: "auth", path: "/evil", worktreePath: "/evil" },
	});
	expect(seen.path).toBe("/repo");
	expect(seen.worktreePath).toBe("/repo");
});

it("does NOT add an injected arg the tool's schema lacks", async () => {
	const fx = fakeSession();
	let seen: Record<string, unknown> = {};
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "stub", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "ping", props: ["msg"] }], (_t, a) => {
				seen = a;
				return { output: "ok", status: "ok" };
			}),
	});
	await host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "stub__ping",
		args: { msg: "hi" },
	});
	expect("worktreePath" in seen).toBe(false);
	expect("path" in seen).toBe(false);
});

it("denies a policy-blocked tool without calling the server", async () => {
	const fx = fakeSession();
	const call = vi.fn();
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: { cortex__purge_memory: "deny" },
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "purge_memory" }], () => {
				call();
				return { output: "x", status: "ok" };
			}),
	});
	await host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c2",
		name: "cortex__purge_memory",
		args: {},
	});
	expect(call).not.toHaveBeenCalled();
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/blocked|denied|policy/i);
});

it("returns an error tool_result when the server call rejects (crash) — no missing reply", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "recall_memory", props: ["worktreePath"] }], () =>
				Promise.reject(new Error("server died")),
			),
	});
	await host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c3",
		name: "cortex__recall_memory",
		args: {},
	});
	expect(fx.results[0][0]).toBe("c3");
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/failed|died/i);
});

it("returns an error tool_result when a call exceeds the per-call timeout (before hax backstop)", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		callTimeoutMs: 20,
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient(
				[{ name: "recall_memory", props: ["worktreePath"] }],
				() => new Promise(() => {}) as Promise<never>,
			),
	});
	await host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c4",
		name: "cortex__recall_memory",
		args: {},
	});
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/timed out|failed/i);
});

it("hostToolNames lists every connected tool, advertised and host-private (M11)", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "standalone",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		hostPrivateTools: ["cortex__capture_session"],
		connect: async () =>
			fakeClient(
				[{ name: "rehydrate_project", props: ["path"] }, { name: "capture_session" }],
				() => ({ output: "", status: "ok" }),
			),
	});
	await host.start(fx.session as never);
	expect(host.hostToolNames().sort()).toEqual([
		"cortex__capture_session",
		"cortex__rehydrate_project",
	]);
});
