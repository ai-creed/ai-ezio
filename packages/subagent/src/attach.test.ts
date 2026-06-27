import { expect, it } from "vitest";
import { loadSubagentHost, makeChildSession } from "./attach.js";

it("builds a host whose catalog reflects the injected codex probe", () => {
	const fixture = JSON.stringify({
		models: [
			{
				slug: "gpt-5.4-mini",
				display_name: "GPT-5.4-mini",
				visibility: "list",
				supported_in_api: true,
				priority: 23,
			},
		],
	});
	const host = loadSubagentHost({
		cwd: "/repo",
		env: { XDG_CONFIG_HOME: "/nonexistent" },
		probeRun: () => fixture,
	});
	// Collect advertised tools directly from the provider shape.
	const tools = host.tools();
	const def = (
		tools as Array<{
			name: string;
			parametersSchema: { properties: { profile: { enum: string[] } } };
		}>
	)[0];
	expect(def.name).toBe("subagent");
	expect(def.parametersSchema.properties.profile.enum).toEqual(["gpt-5.4-mini"]);
});

it("registers nothing when codex is unusable and no user profiles exist", () => {
	const host = loadSubagentHost({
		cwd: "/repo",
		env: { XDG_CONFIG_HOME: "/nonexistent" },
		probeRun: () => null,
	});
	expect(host.tools()).toEqual([]);
});

it("makeChildSession forwards registerDelegatedTools and sendToolResult to the underlying Session", () => {
	const calls: string[] = [];
	const fakeSession = {
		start: async () => ({}),
		submitAndWait: async () => ({ turnId: "t", content: "c" }),
		close: () => {},
		registerDelegatedTools: (t: unknown[]) => calls.push(`register:${t.length}`),
		sendToolResult: (id: string, out: string, st: string) =>
			calls.push(`result:${id}:${out}:${st}`),
	};
	const child = makeChildSession(fakeSession as never);
	child.registerDelegatedTools?.([{ name: "x" } as never]);
	child.sendToolResult?.("c1", "OUT", "ok");
	expect(calls).toEqual(["register:1", "result:c1:OUT:ok"]);
});

it("pushes a doctor-visible note into the notes sink when the codex probe returns garbage", () => {
	const notes: string[] = [];
	const host = loadSubagentHost({
		cwd: "/repo",
		env: { XDG_CONFIG_HOME: "/nonexistent" },
		probeRun: () => "garbage-not-json",
		notes,
	});
	expect(host.tools()).toEqual([]); // no seed + no user profiles -> nothing registered
	expect(notes.some((n) => /codex debug models/.test(n))).toBe(true); // doctor-visible note recorded
});
