import { expect, it, vi } from "vitest";
import { DelegatedToolRegistry } from "@ai-ezio/harness";
import { SubagentHost, subagentToolDef } from "./host.js";
import { buildCatalog } from "./catalog.js";
import { seedCodexProfiles, parseCodexModels } from "./codex-probe.js";

const FIXTURE = JSON.stringify({
	models: [
		{
			slug: "gpt-5.5",
			display_name: "GPT-5.5",
			visibility: "list",
			supported_in_api: true,
			priority: 7,
		},
		{
			slug: "gpt-5.4-mini",
			display_name: "GPT-5.4-mini",
			visibility: "list",
			supported_in_api: true,
			priority: 23,
		},
	],
});

function catalogFromFixture() {
	return buildCatalog({
		config: { default: undefined, subagentTimeoutMs: 1000, profiles: {} },
		seed: seedCodexProfiles(parseCodexModels(FIXTURE)),
	});
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

/** Capture replies injected by the registry / handleToolCall. */
function capture() {
	const replies: Array<[string, string, string]> = [];
	return {
		replies,
		reply: (id: string, out: string, st: string) => replies.push([id, out, st]) as unknown as void,
	};
}

it("subagentToolDef exposes the catalog names as the profile enum", () => {
	const def = subagentToolDef(catalogFromFixture());
	expect(def.name).toBe("subagent");
	const schema = def.parametersSchema as { properties: { profile: { enum: string[] } } };
	expect(schema.properties.profile.enum).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
});

// ── tools() ────────────────────────────────────────────────────────────────

it("tools() returns [] when the catalog is empty", () => {
	const host = new SubagentHost({
		catalog: buildCatalog({
			config: { default: undefined, subagentTimeoutMs: 1000, profiles: {} },
			seed: { profiles: {}, cheapest: undefined },
		}),
		cwd: "/repo",
		parentEnv: {},
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	expect(host.tools()).toEqual([]);
});

it("tools() returns the subagent def when the catalog is non-empty, [] when empty", () => {
	const full = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	expect(full.tools().map((d) => d.name)).toEqual(["subagent"]);
	const empty = new SubagentHost({
		catalog: buildCatalog({
			config: { default: undefined, subagentTimeoutMs: 1, profiles: {} },
			seed: { profiles: {}, cheapest: undefined },
		}),
		cwd: "/repo",
		parentEnv: {},
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	expect(empty.tools()).toEqual([]);
});

// ── handleToolCall ──────────────────────────────────────────────────────────

it("dispatches a subagent call and replies with the result", async () => {
	const { replies, reply } = capture();
	const dispatch = vi.fn(() => ({
		promise: Promise.resolve({ output: "answer", status: "ok" as const, elapsedMs: 5 }),
		cancel: vi.fn(),
	}));
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	await host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "c1",
			name: "subagent",
			args: { task: "go", profile: "gpt-5.4-mini" },
		},
		reply,
	);
	expect(dispatch).toHaveBeenCalledWith(
		expect.objectContaining({
			task: "go",
			profile: expect.objectContaining({ model: "gpt-5.4-mini" }),
		}),
	);
	expect(replies[0]).toEqual(["c1", "answer", "ok"]);
});

it("reports an elapsed + token-count summary from the child's usage", async () => {
	const { replies, reply } = capture();
	const reports: string[] = [];
	const dispatch = vi.fn(() => ({
		promise: Promise.resolve({
			output: "answer",
			status: "ok" as const,
			elapsedMs: 12340,
			usage: { outputTokens: 4200 },
		}),
		cancel: vi.fn(),
	}));
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
		report: (line) => reports.push(line),
	});
	await host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "cR",
			name: "subagent",
			args: { task: "go", profile: "gpt-5.4-mini" },
		},
		reply,
	);
	const done = reports.find((l) => l.startsWith("✔"));
	expect(done).toBeDefined();
	expect(done).toMatch(/12\.3s/); // elapsed from elapsedMs
	expect(done).toMatch(/4\.2k tok/); // token count from usage.outputTokens
	expect(replies[0]).toEqual(["cR", "answer", "ok"]);
});

it("unknown profile -> error result, no dispatch", async () => {
	const { replies, reply } = capture();
	const dispatch = vi.fn();
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	await host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "c2",
			name: "subagent",
			args: { task: "go", profile: "nope" },
		},
		reply,
	);
	expect(dispatch).not.toHaveBeenCalled();
	expect(replies[0][0]).toBe("c2");
	expect(replies[0][2]).toBe("error");
	expect(replies[0][1]).toMatch(/unknown profile/);
});

it("omitted profile resolves to the catalog default", async () => {
	const { reply } = capture();
	const dispatch = vi.fn(() => ({
		promise: Promise.resolve({ output: "ok", status: "ok" as const, elapsedMs: 1 }),
		cancel: vi.fn(),
	}));
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	await host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "c3",
			name: "subagent",
			args: { task: "go" },
		},
		reply,
	);
	expect(dispatch).toHaveBeenCalledWith(
		expect.objectContaining({ profile: expect.objectContaining({ model: "gpt-5.4-mini" }) }),
	);
});

it("handleToolCall replies an error when task is missing/blank, without dispatching", async () => {
	const dispatch = vi.fn();
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	const { replies, reply } = capture();
	await host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "c0",
			name: "subagent",
			args: { task: "   " },
		},
		reply,
	);
	expect(dispatch).not.toHaveBeenCalled();
	expect(replies[0]).toEqual(["c0", "subagent: missing 'task'", "error"]);
});

// ── observe ─────────────────────────────────────────────────────────────────

it("observe ignores events that are not idle or error", () => {
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	const { replies } = capture();
	// Should not throw or route anything
	host.observe({ type: "tool_result" } as never);
	host.observe({ type: "content_block_started" } as never);
	expect(replies).toEqual([]);
});

it("cancels the in-flight dispatch when the parent turn ends while running", async () => {
	const cancel = vi.fn();
	let settle: (v: { output: string; status: "ok" | "error"; elapsedMs: number }) => void = () => {};
	const dispatch = vi.fn(() => ({
		promise: new Promise<{ output: string; status: "ok" | "error"; elapsedMs: number }>(
			(r) => (settle = r),
		),
		cancel,
	}));
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	const { reply } = capture();
	const p = host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "c4",
			name: "subagent",
			args: { task: "go" },
		},
		reply,
	);
	await Promise.resolve();
	host.observe({ type: "idle" }); // parent turn aborted mid-dispatch
	expect(cancel).toHaveBeenCalled();
	settle({ output: "subagent dispatch canceled", status: "error", elapsedMs: 1 });
	await p;
});

// ── new provider-shape tests from the brief ────────────────────────────────

it("handleToolCall dispatches and replies via the injected reply; observe(idle) cancels in-flight", async () => {
	const cancel = vi.fn();
	let settle: (v: { output: string; status: "ok" | "error"; elapsedMs: number }) => void = () => {};
	const dispatch = vi.fn(
		() =>
			({
				promise: new Promise<{ output: string; status: "ok" | "error"; elapsedMs: number }>(
					(r) => (settle = r),
				),
				cancel,
			}) as never,
	);
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	const replies: Array<[string, string, string]> = [];
	const p = host.handleToolCall(
		{
			type: "tool_call_requested",
			turnId: "t",
			callId: "c1",
			name: "subagent",
			args: { task: "go", profile: "gpt-5.4-mini" },
		},
		(id, out, st) => replies.push([id, out, st]) as unknown as void,
	);
	await Promise.resolve();
	host.observe({ type: "idle" }); // parent abort mid-dispatch
	expect(cancel).toHaveBeenCalled();
	settle({ output: "x", status: "error", elapsedMs: 1 });
	await p;
});

it("works behind the registry: a subagent call is routed + replied, never 'unknown tool'", async () => {
	const fx = fakeSession();
	const dispatch = vi.fn(() => ({
		promise: Promise.resolve({ output: "ANSWER", status: "ok" as const, elapsedMs: 2 }),
		cancel: vi.fn(),
	}));
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	const reg = new DelegatedToolRegistry([host]);
	await reg.start(fx.session as never);
	reg.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "subagent",
		args: { task: "go", profile: "gpt-5.4-mini" },
	});
	await new Promise((r) => setTimeout(r, 0));
	expect(fx.results[0]).toEqual(["c1", "ANSWER", "ok"]);
});
