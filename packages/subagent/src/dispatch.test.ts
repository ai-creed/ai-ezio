import { expect, it, vi } from "vitest";
import { runSubagent, type ChildSession, type ChildMcp } from "./dispatch.js";

function fakeMcp(): ChildMcp {
	return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
}

it("runs the task and returns the child's final content", async () => {
	const close = vi.fn();
	const mcp = fakeMcp();
	const child: ChildSession = {
		start: vi.fn(async () => ({})),
		submitAndWait: vi.fn(async () => ({ content: "done: 3 TODOs", usage: { outputTokens: 42 } })),
		close,
	};
	const handle = runSubagent({
		task: "find TODOs",
		profile: { provider: "codex", model: "gpt-5.4-mini" },
		cwd: "/repo",
		parentEnv: { HOME: "/h" },
		timeoutMs: 1000,
		makeSession: () => child,
		makeMcpHost: () => mcp,
	});
	const r = await handle.promise;
	expect(r.status).toBe("ok");
	expect(r.output).toBe("done: 3 TODOs");
	expect(child.start).toHaveBeenCalledWith({
		env: expect.objectContaining({ HAX_MODEL: "gpt-5.4-mini" }),
	});
	expect(mcp.start).toHaveBeenCalled();
	expect(close).toHaveBeenCalled(); // torn down
	expect(mcp.stop).toHaveBeenCalled();
	expect(r.usage).toEqual({ outputTokens: 42 }); // child usage propagated for the surface
});

it("missing required key -> error result, no child spawned", async () => {
	const makeSession = vi.fn();
	const handle = runSubagent({
		task: "x",
		profile: { provider: "openrouter", model: "m", apiKeyEnv: "OPENROUTER_API_KEY" },
		cwd: "/repo",
		parentEnv: {},
		timeoutMs: 1000,
		makeSession: makeSession as never,
		makeMcpHost: fakeMcp as never,
	});
	const r = await handle.promise;
	expect(r.status).toBe("error");
	expect(r.output).toMatch(/OPENROUTER_API_KEY/);
	expect(makeSession).not.toHaveBeenCalled();
});

it("a child error resolves as an error result and still tears down", async () => {
	const close = vi.fn();
	const mcp = fakeMcp();
	const child: ChildSession = {
		start: vi.fn(async () => ({})),
		submitAndWait: vi.fn(async () => {
			throw new Error("engine exited mid-turn");
		}),
		close,
	};
	const r = await runSubagent({
		task: "x",
		profile: { provider: "codex", model: "gpt-5.4-mini" },
		cwd: "/repo",
		parentEnv: {},
		timeoutMs: 1000,
		makeSession: () => child,
		makeMcpHost: () => mcp,
	}).promise;
	expect(r.status).toBe("error");
	expect(r.output).toMatch(/engine exited mid-turn/);
	expect(close).toHaveBeenCalled();
});

it("times out, kills the child, and reports an error", async () => {
	vi.useFakeTimers();
	const close = vi.fn();
	const child: ChildSession = {
		start: vi.fn(async () => ({})),
		submitAndWait: vi.fn(() => new Promise(() => {})), // never resolves
		close,
	};
	const handle = runSubagent({
		task: "x",
		profile: { provider: "codex", model: "gpt-5.4-mini" },
		cwd: "/repo",
		parentEnv: {},
		timeoutMs: 50,
		makeSession: () => child,
		makeMcpHost: () => fakeMcp(),
	});
	await vi.advanceTimersByTimeAsync(60);
	const r = await handle.promise;
	expect(r.status).toBe("error");
	expect(r.output).toMatch(/timed out/);
	expect(close).toHaveBeenCalled();
	vi.useRealTimers();
});

it("cancel() tears down the child AND stops the child MCP, resolving promptly", async () => {
	const close = vi.fn();
	const mcp = fakeMcp();
	const child: ChildSession = {
		start: vi.fn(async () => ({})),
		submitAndWait: vi.fn(() => new Promise(() => {})), // never settles on its own
		close,
	};
	const handle = runSubagent({
		task: "x",
		profile: { provider: "codex", model: "gpt-5.4-mini" },
		cwd: "/repo",
		parentEnv: {},
		timeoutMs: 10_000,
		makeSession: () => child,
		makeMcpHost: () => mcp,
	});
	// let start() settle, then cancel
	await Promise.resolve();
	handle.cancel();
	const r = await handle.promise; // resolves promptly via the cancel signal — no hang, no fake timers
	expect(r.status).toBe("error");
	expect(r.output).toMatch(/cancel/i);
	expect(close).toHaveBeenCalled();
	expect(mcp.stop).toHaveBeenCalled(); // child MCP stopped immediately — no orphan remains
});

it("a throwing child factory resolves as an error (never rejects)", async () => {
	const handle = runSubagent({
		task: "x",
		profile: { provider: "codex", model: "gpt-5.4-mini" },
		cwd: "/repo",
		parentEnv: {},
		timeoutMs: 1000,
		makeSession: (() => ({})) as never,
		makeMcpHost: () => {
			throw new Error("factory boom");
		},
	});
	const r = await handle.promise; // must not throw
	expect(r.status).toBe("error");
	expect(r.output).toMatch(/factory boom/);
});
