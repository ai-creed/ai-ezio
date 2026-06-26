import { expect, it, vi } from "vitest";
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

it("subagentToolDef exposes the catalog names as the profile enum", () => {
	const def = subagentToolDef(catalogFromFixture());
	expect(def.name).toBe("subagent");
	const schema = def.parametersSchema as { properties: { profile: { enum: string[] } } };
	expect(schema.properties.profile.enum).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
});

it("registers nothing when the catalog is empty", () => {
	const fx = fakeSession();
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
	host.start(fx.session as never);
	expect(fx.registered).toEqual([]);
});

it("dispatches a subagent call and replies with the result", async () => {
	const fx = fakeSession();
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
	host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c1",
		name: "subagent",
		args: { task: "go", profile: "gpt-5.4-mini" },
	});
	expect(dispatch).toHaveBeenCalledWith(
		expect.objectContaining({
			task: "go",
			profile: expect.objectContaining({ model: "gpt-5.4-mini" }),
		}),
	);
	expect(fx.results[0]).toEqual(["c1", "answer", "ok"]);
});

it("reports an elapsed + token-count summary from the child's usage", async () => {
	const fx = fakeSession();
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
	host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "cR",
		name: "subagent",
		args: { task: "go", profile: "gpt-5.4-mini" },
	});
	const done = reports.find((l) => l.startsWith("✔"));
	expect(done).toBeDefined();
	expect(done).toMatch(/12\.3s/); // elapsed from elapsedMs
	expect(done).toMatch(/4\.2k tok/); // token count from usage.outputTokens
	expect(fx.results[0]).toEqual(["cR", "answer", "ok"]);
});

it("unknown profile -> error result, no dispatch", async () => {
	const fx = fakeSession();
	const dispatch = vi.fn();
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		dispatch: dispatch as never,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c2",
		name: "subagent",
		args: { task: "go", profile: "nope" },
	});
	expect(dispatch).not.toHaveBeenCalled();
	expect(fx.results[0][0]).toBe("c2");
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/unknown profile/);
});

it("omitted profile resolves to the catalog default", async () => {
	const fx = fakeSession();
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
	host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c3",
		name: "subagent",
		args: { task: "go" },
	});
	expect(dispatch).toHaveBeenCalledWith(
		expect.objectContaining({ profile: expect.objectContaining({ model: "gpt-5.4-mini" }) }),
	);
});

it("ignores non-subagent tool_call_requested and other events", async () => {
	const fx = fakeSession();
	const host = new SubagentHost({
		catalog: catalogFromFixture(),
		cwd: "/repo",
		parentEnv: {},
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});
	host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "x",
		name: "cortex__recall_memory",
		args: {},
	});
	await host.handleEvent({ type: "idle" });
	expect(fx.results).toEqual([]);
});

it("cancels the in-flight dispatch when the parent turn ends while running", async () => {
	const fx = fakeSession();
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
	host.start(fx.session as never);
	const p = host.handleEvent({
		type: "tool_call_requested",
		turnId: "t",
		callId: "c4",
		name: "subagent",
		args: { task: "go" },
	});
	await Promise.resolve();
	await host.handleEvent({ type: "idle" }); // parent turn aborted mid-dispatch
	expect(cancel).toHaveBeenCalled();
	settle({ output: "subagent dispatch canceled", status: "error", elapsedMs: 1 });
	await p;
});
