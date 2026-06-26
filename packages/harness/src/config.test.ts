import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPACTION_DEFAULTS, configFilePath, loadConfig } from "./config.js";

/** A fake env whose XDG_CONFIG_HOME points at a fresh temp dir; returns both
 * the env and a writer for ai-ezio/config.json under it. */
function fakeEnv(): { env: NodeJS.ProcessEnv; write: (content: string) => void } {
	const base = mkdtempSync(join(tmpdir(), "ezio-config-"));
	const env = { XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv;
	return {
		env,
		write: (content) => {
			mkdirSync(join(base, "ai-ezio"), { recursive: true });
			writeFileSync(join(base, "ai-ezio", "config.json"), content);
		},
	};
}

describe("configFilePath", () => {
	it("resolves under XDG_CONFIG_HOME, falling back to ~/.config", () => {
		expect(configFilePath({ XDG_CONFIG_HOME: "/x" } as NodeJS.ProcessEnv)).toBe(
			"/x/ai-ezio/config.json",
		);
		expect(configFilePath({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe(
			"/home/u/.config/ai-ezio/config.json",
		);
	});
});

describe("loadConfig", () => {
	it("missing file -> defaults, no notes", () => {
		const { env } = fakeEnv();
		const cfg = loadConfig(env);
		expect(cfg.compaction).toEqual(COMPACTION_DEFAULTS);
		expect(cfg.notes).toEqual([]);
	});

	it("missing section -> defaults", () => {
		const { env, write } = fakeEnv();
		write(JSON.stringify({ other: true }));
		expect(loadConfig(env).compaction).toEqual(COMPACTION_DEFAULTS);
	});

	it("parses a full compaction section", () => {
		const { env, write } = fakeEnv();
		write(
			JSON.stringify({
				compaction: { auto: false, threshold: 0.5, keepLastTurns: 4, rehydrate: false },
			}),
		);
		expect(loadConfig(env).compaction).toEqual({
			auto: false,
			threshold: 0.5,
			keepLastTurns: 4,
			rehydrate: false,
		});
	});

	it("clamps out-of-range values with a doctor-visible note each", () => {
		const { env, write } = fakeEnv();
		write(JSON.stringify({ compaction: { threshold: 0.1, keepLastTurns: 99 } }));
		const cfg = loadConfig(env);
		expect(cfg.compaction.threshold).toBe(0.3);
		expect(cfg.compaction.keepLastTurns).toBe(10);
		expect(cfg.notes).toHaveLength(2);
		expect(cfg.notes[0]).toMatch(/threshold/);
		expect(cfg.notes[1]).toMatch(/keepLastTurns/);

		const high = fakeEnv();
		high.write(JSON.stringify({ compaction: { threshold: 2, keepLastTurns: -1 } }));
		const c2 = loadConfig(high.env);
		expect(c2.compaction.threshold).toBe(0.95);
		expect(c2.compaction.keepLastTurns).toBe(0);
	});

	it("malformed JSON -> defaults plus a note, never throws", () => {
		const { env, write } = fakeEnv();
		write("{nope");
		const cfg = loadConfig(env);
		expect(cfg.compaction).toEqual(COMPACTION_DEFAULTS);
		expect(cfg.notes).toHaveLength(1);
		expect(cfg.notes[0]).toMatch(/unreadable/);
	});

	it("missing subagents section -> empty profiles, default timeout", () => {
		const { env } = fakeEnv();
		const cfg = loadConfig(env);
		expect(cfg.subagents).toEqual({
			default: undefined,
			subagentTimeoutMs: 300000,
			profiles: {},
		});
	});

	it("parses a subagents section with profiles and clamps a bad timeout", () => {
		const { env, write } = fakeEnv();
		write(
			JSON.stringify({
				subagents: {
					default: "gpt-5.4-mini",
					subagentTimeoutMs: -5,
					profiles: {
						"gpt-5.4-mini": { provider: "codex", model: "gpt-5.4-mini", effort: "low" },
						local: { provider: "ollama", model: "qwen3:8b", label: "offline" },
					},
				},
			}),
		);
		const cfg = loadConfig(env);
		expect(cfg.subagents.default).toBe("gpt-5.4-mini");
		expect(cfg.subagents.subagentTimeoutMs).toBe(300000); // -5 clamped to default
		expect(cfg.subagents.profiles["gpt-5.4-mini"]).toEqual({
			provider: "codex",
			model: "gpt-5.4-mini",
			effort: "low",
		});
		expect(cfg.subagents.profiles.local.label).toBe("offline");
	});

	it("drops malformed profiles (missing provider/model) with a note", () => {
		const { env, write } = fakeEnv();
		write(
			JSON.stringify({
				subagents: {
					profiles: { bad: { provider: "openai" }, ok: { provider: "openai", model: "x" } },
				},
			}),
		);
		const cfg = loadConfig(env);
		expect(Object.keys(cfg.subagents.profiles)).toEqual(["ok"]);
		expect(cfg.notes.some((n) => n.includes("bad"))).toBe(true);
	});
});
