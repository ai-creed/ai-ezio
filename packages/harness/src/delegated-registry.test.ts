import { describe, expect, it, vi } from "vitest";
import { DelegatedToolRegistry, type DelegatedToolProvider } from "./delegated-registry.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";

function def(name: string): DelegatedToolDef {
	return { name, description: name, parametersSchema: { type: "object" } };
}

function fakeSession() {
	const registered: DelegatedToolDef[][] = [];
	const results: Array<[string, string, string]> = [];
	return {
		registered,
		results,
		session: {
			registerDelegatedTools: (t: DelegatedToolDef[]) => registered.push(t),
			sendToolResult: (id: string, out: string, st: string) => results.push([id, out, st]),
		},
	};
}

/** A configurable fake provider. */
function fakeProvider(
	id: string,
	names: string[],
	opts: { initThrows?: boolean } = {},
): DelegatedToolProvider & {
	calls: string[];
	observed: string[];
	stopped: boolean;
} {
	const calls: string[] = [];
	const observed: string[] = [];
	return {
		id,
		calls,
		observed,
		stopped: false,
		async init() {
			if (opts.initThrows) throw new Error(`${id} init boom`);
		},
		tools: () => names.map(def),
		handleToolCall(event, reply) {
			calls.push(event.name);
			reply(event.callId, `${id}:${event.name}`, "ok");
		},
		observe(event) {
			observed.push(event.type);
		},
		async stop() {
			(this as { stopped: boolean }).stopped = true;
		},
	};
}

describe("DelegatedToolRegistry", () => {
	it("merges all providers' tools into ONE registration and routes a call to its owner", async () => {
		const fx = fakeSession();
		const mcp = fakeProvider("mcp", ["a__x"]);
		const sub = fakeProvider("subagent", ["subagent"]);
		const reg = new DelegatedToolRegistry([mcp, sub]);
		await reg.start(fx.session as never);
		expect(fx.registered.length).toBe(1); // one merged call
		expect(fx.registered[0]!.map((d) => d.name).sort()).toEqual(["a__x", "subagent"]);

		reg.handleEvent({
			type: "tool_call_requested",
			turnId: "t",
			callId: "c1",
			name: "subagent",
			args: {},
		});
		expect(sub.calls).toEqual(["subagent"]);
		expect(mcp.calls).toEqual([]); // only the owner saw it
		expect(fx.results).toEqual([["c1", "subagent:subagent", "ok"]]);
	});

	it("broadcasts non-tool-call (lifecycle) events to every observer", async () => {
		const fx = fakeSession();
		const mcp = fakeProvider("mcp", ["a__x"]);
		const sub = fakeProvider("subagent", ["subagent"]);
		const reg = new DelegatedToolRegistry([mcp, sub]);
		await reg.start(fx.session as never);
		reg.handleEvent({ type: "idle" });
		expect(mcp.observed).toEqual(["idle"]);
		expect(sub.observed).toEqual(["idle"]);
	});

	it("warns and keeps the first on a duplicate tool name", async () => {
		const fx = fakeSession();
		const warn = vi.fn();
		const a = fakeProvider("a", ["dup"]);
		const b = fakeProvider("b", ["dup"]);
		const reg = new DelegatedToolRegistry([a, b], warn);
		await reg.start(fx.session as never);
		expect(fx.registered[0]!.map((d) => d.name)).toEqual(["dup"]); // only one
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dup.*collides/));
		reg.handleEvent({
			type: "tool_call_requested",
			turnId: "t",
			callId: "c",
			name: "dup",
			args: {},
		});
		expect(a.calls).toEqual(["dup"]); // first owns it
		expect(b.calls).toEqual([]);
	});

	it("isolates a provider whose init() throws: its tools are absent, the rest register, start() resolves", async () => {
		const fx = fakeSession();
		const warn = vi.fn();
		const bad = fakeProvider("bad", ["bad__y"], { initThrows: true });
		const good = fakeProvider("good", ["good__z"]);
		const reg = new DelegatedToolRegistry([bad, good], warn);
		await expect(reg.start(fx.session as never)).resolves.toBeUndefined(); // does not reject
		expect(fx.registered[0]!.map((d) => d.name)).toEqual(["good__z"]); // bad contributes nothing
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/bad.*init failed/));
		reg.handleEvent({
			type: "tool_call_requested",
			turnId: "t",
			callId: "c",
			name: "bad__y",
			args: {},
		});
		expect(fx.results).toEqual([]); // no owner → ignored
	});

	it("is idempotent on repeated start: rebuilds owner map from current tools(), no stale routes", async () => {
		const fx = fakeSession();
		let names = ["a__x", "a__y"];
		const p: DelegatedToolProvider = {
			id: "a",
			init: async () => {},
			tools: () => names.map(def),
			handleToolCall: (e, reply) => reply(e.callId, "ok", "ok"),
		};
		const reg = new DelegatedToolRegistry([p]);
		await reg.start(fx.session as never);
		expect(fx.registered[0]!.map((d) => d.name)).toEqual(["a__x", "a__y"]);
		names = ["a__x"]; // a__y removed on the next (resume) start
		await reg.start(fx.session as never);
		expect(fx.registered[1]!.map((d) => d.name)).toEqual(["a__x"]);
		reg.handleEvent({
			type: "tool_call_requested",
			turnId: "t",
			callId: "c",
			name: "a__y",
			args: {},
		});
		expect(fx.results).toEqual([]); // stale tool no longer owned/routed
	});

	it("stop() stops every provider", async () => {
		const fx = fakeSession();
		const a = fakeProvider("a", ["a__x"]);
		const b = fakeProvider("b", ["b__y"]);
		const reg = new DelegatedToolRegistry([a, b]);
		await reg.start(fx.session as never);
		await reg.stop();
		expect(a.stopped).toBe(true);
		expect(b.stopped).toBe(true);
	});
});
