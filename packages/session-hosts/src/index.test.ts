import { expect, it } from "vitest";
import { ensureDelegatedTimeout, loadSessionHosts } from "./index.js";

it("ensureDelegatedTimeout sets the 30-minute backstop in SECONDS, only when unset", () => {
	const fresh: NodeJS.ProcessEnv = {};
	ensureDelegatedTimeout(fresh);
	expect(fresh.AI_EZIO_DELEGATED_TIMEOUT).toBe("1800"); // 1800 SECONDS = 30 min
	const overridden: NodeJS.ProcessEnv = { AI_EZIO_DELEGATED_TIMEOUT: "60" };
	ensureDelegatedTimeout(overridden);
	expect(overridden.AI_EZIO_DELEGATED_TIMEOUT).toBe("60");
});

it("loadSessionHosts returns a registry + mcpHost and sets the timeout", () => {
	const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/nonexistent", HOME: "/nonexistent" }; // no mcp.json/subagents config
	const { registry, mcpHost } = loadSessionHosts({
		mode: "mounted",
		cwd: "/repo",
		env,
		probeRun: undefined,
	} as never);
	expect(registry).toBeDefined();
	expect(typeof mcpHost.callHostTool).toBe("function"); // host-private API present
	expect(env.AI_EZIO_DELEGATED_TIMEOUT).toBe("1800");
});
