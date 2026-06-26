import { expect, it, describe } from "vitest";
import { parseCodexModels, probeCodexModels, seedCodexProfiles } from "./codex-probe.js";
import { buildCatalog } from "./catalog.js";

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
			slug: "gpt-5.4",
			display_name: "GPT-5.4",
			visibility: "list",
			supported_in_api: true,
			priority: 16,
		},
		{
			slug: "gpt-5.4-mini",
			display_name: "GPT-5.4-mini",
			visibility: "list",
			supported_in_api: true,
			priority: 23,
		},
		{
			slug: "codex-auto-review",
			display_name: "x",
			visibility: "hide",
			supported_in_api: true,
			priority: 43,
		},
		{
			slug: "no-api",
			display_name: "NoAPI",
			visibility: "list",
			supported_in_api: false,
			priority: 99,
		},
	],
});

describe("parseCodexModels", () => {
	it("keeps list+api models, drops hidden and non-API", () => {
		const ms = parseCodexModels(FIXTURE);
		expect(ms.map((m) => m.slug)).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
		expect(ms.map((m) => m.slug)).not.toContain("no-api"); // supported_in_api: false dropped
		expect(ms.map((m) => m.slug)).not.toContain("codex-auto-review"); // visibility: hide dropped
	});
	it("returns [] on garbage", () => {
		expect(parseCodexModels("not json")).toEqual([]);
		expect(parseCodexModels(JSON.stringify({ nope: 1 }))).toEqual([]);
	});
});

describe("probeCodexModels", () => {
	it("codex not in play (runner yields null) -> empty seed, NO note", () => {
		expect(probeCodexModels({ run: () => null })).toEqual({ models: [], note: undefined });
	});
	it("parses runner output (no note on success)", () => {
		const r = probeCodexModels({ run: () => FIXTURE });
		expect(r.models.map((m) => m.slug)).toContain("gpt-5.4-mini");
		expect(r.note).toBeUndefined();
	});
	it("garbage/unparseable output -> empty seed + a doctor-visible note", () => {
		const r = probeCodexModels({ run: () => "not json at all" });
		expect(r.models).toEqual([]);
		expect(r.note).toMatch(/codex debug models/);
	});
	it("a throwing runner -> empty seed + a note (never throws)", () => {
		const r = probeCodexModels({
			run: () => {
				throw new Error("codex: command not found");
			},
		});
		expect(r.models).toEqual([]);
		expect(r.note).toMatch(/command not found/);
	});
});

describe("seedCodexProfiles", () => {
	it("emits one codex profile per slug and picks the mini as cheapest", () => {
		const { profiles, cheapest } = seedCodexProfiles(parseCodexModels(FIXTURE));
		expect(profiles["gpt-5.4-mini"]).toEqual({
			provider: "codex",
			model: "gpt-5.4-mini",
			label: "GPT-5.4-mini",
		});
		expect(cheapest).toBe("gpt-5.4-mini");
	});
	it("falls back to highest-priority slug when none match /mini/", () => {
		const ms = parseCodexModels(
			JSON.stringify({
				models: [
					{ slug: "a", display_name: "A", visibility: "list", supported_in_api: true, priority: 5 },
					{ slug: "b", display_name: "B", visibility: "list", supported_in_api: true, priority: 9 },
				],
			}),
		);
		expect(seedCodexProfiles(ms).cheapest).toBe("b");
	});
});

describe("buildCatalog", () => {
	it("merges user profiles over the seed; user wins on collision", () => {
		const seed = seedCodexProfiles(parseCodexModels(FIXTURE));
		const cat = buildCatalog({
			config: {
				default: undefined,
				subagentTimeoutMs: 300000,
				profiles: {
					"gpt-5.4-mini": { provider: "codex", model: "gpt-5.4-mini", effort: "low" },
					claude: {
						provider: "openrouter",
						model: "anthropic/claude-sonnet-4.6",
						apiKeyEnv: "OPENROUTER_API_KEY",
					},
				},
			},
			seed,
		});
		expect(cat.profiles["gpt-5.4-mini"].effort).toBe("low"); // user override won
		expect(cat.profiles.claude.provider).toBe("openrouter"); // added
		expect(cat.names).toContain("gpt-5.5");
		expect(cat.default).toBe("gpt-5.4-mini"); // cheapest seeded, no user default
	});

	it("user default wins; empty seed + empty config -> empty catalog", () => {
		const withDefault = buildCatalog({
			config: {
				default: "claude",
				subagentTimeoutMs: 1,
				profiles: { claude: { provider: "openrouter", model: "x" } },
			},
			seed: { profiles: {}, cheapest: undefined },
		});
		expect(withDefault.default).toBe("claude");
		expect(withDefault.timeoutMs).toBe(1);

		const empty = buildCatalog({
			config: { default: undefined, subagentTimeoutMs: 300000, profiles: {} },
			seed: { profiles: {}, cheapest: undefined },
		});
		expect(empty.names).toEqual([]);
		expect(empty.default).toBeUndefined();
	});
});
