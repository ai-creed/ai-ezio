import { describe, expect, it } from "vitest";
import { configPath, parseConfig } from "./config.js";

describe("config", () => {
	it("parses servers + tool policy", () => {
		const cfg = parseConfig(
			JSON.stringify({
				mcpServers: { cortex: { command: "ai-cortex", args: ["mcp"] } },
				toolPolicy: { cortex__purge_memory: "deny" },
			}),
		);
		expect(cfg.servers).toEqual([
			{ name: "cortex", command: "ai-cortex", args: ["mcp"], env: undefined },
		]);
		expect(cfg.toolPolicy.cortex__purge_memory).toBe("deny");
	});
	it("returns empty config for missing/blank input", () => {
		expect(parseConfig(undefined).servers).toEqual([]);
	});
	it("derives path from XDG_CONFIG_HOME or HOME", () => {
		expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/ai-ezio/mcp.json");
		expect(configPath({ HOME: "/home/u" })).toBe("/home/u/.config/ai-ezio/mcp.json");
	});
});
