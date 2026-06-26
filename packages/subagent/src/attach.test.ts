import { expect, it } from "vitest";
import { loadSubagentHost } from "./attach.js";

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
	// Register against a fake session and assert the seeded tool is advertised.
	const registered: unknown[] = [];
	host.start({
		registerDelegatedTools: (t) => registered.push(t),
		sendToolResult: () => {},
	} as never);
	const def = (
		registered[0] as Array<{
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
	const registered: unknown[] = [];
	host.start({
		registerDelegatedTools: (t) => registered.push(t),
		sendToolResult: () => {},
	} as never);
	expect(registered).toEqual([]);
});

it("pushes a doctor-visible note into the notes sink when the codex probe returns garbage", () => {
	const notes: string[] = [];
	const host = loadSubagentHost({
		cwd: "/repo",
		env: { XDG_CONFIG_HOME: "/nonexistent" },
		probeRun: () => "garbage-not-json",
		notes,
	});
	const registered: unknown[] = [];
	host.start({
		registerDelegatedTools: (t) => registered.push(t),
		sendToolResult: () => {},
	} as never);
	expect(registered).toEqual([]); // no seed + no user profiles -> nothing registered
	expect(notes.some((n) => /codex debug models/.test(n))).toBe(true); // doctor-visible note recorded
});
