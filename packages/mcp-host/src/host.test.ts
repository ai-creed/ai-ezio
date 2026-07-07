import { expect, it, vi } from "vitest";
import { DelegatedToolRegistry } from "@ai-ezio/harness";
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
		callTool: async (t, a) => onCall(t, a),
		close: async () => {},
	};
}

/** Capture replies routed through the registry's DelegatedReply contract. */
function capture() {
	const results: Array<[string, string, string]> = [];
	return {
		results,
		reply: (id: string, out: string, st: "ok" | "error") => void results.push([id, out, st]),
	};
}

/** Minimal RegistrySession for the end-to-end registry test. */
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

function call(name: string, args: Record<string, unknown>) {
	return { type: "tool_call_requested" as const, turnId: "t", callId: "c1", name, args };
}

it("init()/tools() advertise namespaced defs; handleToolCall routes + injects cwd from schema", async () => {
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
	await host.init();
	expect(host.tools().map((d) => d.name)).toEqual(["cortex__recall_memory"]);
	const { results, reply } = capture();
	await host.handleToolCall(call("cortex__recall_memory", { query: "x" }), reply);
	expect(results[0]).toEqual([
		"c1",
		`called recall_memory {"query":"x","worktreePath":"/repo"}`,
		"ok",
	]);
});

it("overrides model-supplied worktreePath AND path (no drift)", async () => {
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
	await host.init();
	await host.handleToolCall(
		call("cortex__suggest_files", { task: "auth", path: "/evil", worktreePath: "/evil" }),
		capture().reply,
	);
	expect(seen.path).toBe("/repo");
	expect(seen.worktreePath).toBe("/repo");
});

it("does NOT add an injected arg the tool's schema lacks", async () => {
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
	await host.init();
	await host.handleToolCall(call("stub__ping", { msg: "hi" }), capture().reply);
	expect("worktreePath" in seen).toBe(false);
	expect("path" in seen).toBe(false);
});

it("denies a policy-blocked tool without calling the server", async () => {
	const onCall = vi.fn(() => ({ output: "x", status: "ok" as const }));
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: { cortex__purge_memory: "deny" },
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () => fakeClient([{ name: "purge_memory" }], onCall),
	});
	await host.init();
	const { results, reply } = capture();
	await host.handleToolCall(call("cortex__purge_memory", {}), reply);
	expect(onCall).not.toHaveBeenCalled();
	expect(results[0][2]).toBe("error");
	expect(results[0][1]).toMatch(/blocked|denied|policy/i);
});

it("returns an error reply when the server call rejects (crash)", async () => {
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
	await host.init();
	const { results, reply } = capture();
	await host.handleToolCall(call("cortex__recall_memory", {}), reply);
	expect(results[0][2]).toBe("error");
	expect(results[0][1]).toMatch(/failed|died/i);
});

it("returns an error reply when a call exceeds the per-call timeout", async () => {
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		callTimeoutMs: 20,
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "recall_memory", props: ["worktreePath"] }], () => new Promise(() => {})),
	});
	await host.init();
	const { results, reply } = capture();
	await host.handleToolCall(call("cortex__recall_memory", {}), reply);
	expect(results[0][2]).toBe("error");
	expect(results[0][1]).toMatch(/timed out|failed/i);
});

it("hostToolNames lists every connected tool; host-private tools are NOT advertised", async () => {
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
	await host.init();
	expect(host.hostToolNames().sort()).toEqual([
		"cortex__capture_session",
		"cortex__rehydrate_project",
	]);
	expect(host.tools().map((d) => d.name)).toEqual(["cortex__rehydrate_project"]); // capture_session not advertised
});

it("callHostTool invokes a host-private tool directly (cwd injected), bypassing advertising", async () => {
	let seen: Record<string, unknown> = {};
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		hostPrivateTools: ["cortex__capture_session"],
		connect: async () =>
			fakeClient([{ name: "capture_session", props: ["worktreePath"] }], (_t, a) => {
				seen = a;
				return { output: "captured", status: "ok" };
			}),
	});
	await host.init();
	const r = await host.callHostTool("cortex__capture_session", {});
	expect(r).toEqual({ output: "captured", status: "ok" });
	expect(seen.worktreePath).toBe("/repo");
});

it("init() is idempotent: a second init closes the first clients and leaves no stale routes", async () => {
	const closed: string[] = [];
	let gen = 0;
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () => {
			const myGen = ++gen;
			return {
				listTools: async () => [
					{ name: `tool${myGen}`, description: "", parametersSchema: { type: "object" } },
				],
				callTool: async () => ({ output: "ok", status: "ok" as const }),
				close: async () => void closed.push(`gen${myGen}`),
			};
		},
	});
	await host.init();
	expect(host.tools().map((d) => d.name)).toEqual(["cortex__tool1"]);
	await host.init(); // resume re-init
	expect(closed).toContain("gen1"); // first client disconnected
	expect(host.tools().map((d) => d.name)).toEqual(["cortex__tool2"]); // no stale cortex__tool1
});

it("works behind the registry end to end (single merged registration + owner-only routing)", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted",
		cwd: "/repo",
		toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "recall_memory", props: ["query"] }], () => ({
				output: "OUT",
				status: "ok",
			})),
	});
	const reg = new DelegatedToolRegistry([host]);
	await reg.start(fx.session);
	expect((fx.registered[0] as Array<{ name: string }>).map((d) => d.name)).toEqual([
		"cortex__recall_memory",
	]);
	reg.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "cortex__recall_memory",
		args: { query: "x" },
	});
	await new Promise((r) => setTimeout(r, 0)); // let the async handleToolCall settle
	expect(fx.results[0]).toEqual(["c1", "OUT", "ok"]);
});
