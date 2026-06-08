import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock spawn so we can inspect the actual launch the CLI performs (spec requires
// asserting the spawn layer, not just the pure launchEnv/mountStdio helpers).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { main } from "./cli.js";

describe("ai-ezio --mount-mode launch layer", () => {
	const savedBin = process.env.AI_EZIO_HAX_BIN;

	beforeEach(() => {
		// resolveHaxBinary needs an existing file; node itself is one (+executable).
		process.env.AI_EZIO_HAX_BIN = process.execPath;
		spawnMock.mockReset();
		const child = {
			on: vi.fn((event: string, cb: (code: number | null, sig: null) => void) => {
				if (event === "exit") setImmediate(() => cb(0, null));
				return child;
			}),
		};
		spawnMock.mockReturnValue(child);
	});

	afterEach(() => {
		if (savedBin === undefined) delete process.env.AI_EZIO_HAX_BIN;
		else process.env.AI_EZIO_HAX_BIN = savedBin;
	});

	it("the real spawn forwards --mount-mode + fds and sets HAX_EXTRA_SKILLS_DIR", async () => {
		await main(["--mount-mode", "--protocol-fd=3", "--control-fd=4"]);

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const call = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ stdio: Array<string>; env: NodeJS.ProcessEnv },
		];
		const [, args, opts] = call;
		expect(args).toContain("--mount-mode"); // flag forwarded to hax
		// the protocol fds are inherited so hax receives them
		expect(opts.stdio[3]).toBe("inherit");
		expect(opts.stdio[4]).toBe("inherit");
		// the engine-visibility bridge is set on the child env
		expect(opts.env.HAX_EXTRA_SKILLS_DIR).toBeDefined();
		expect(opts.env.HAX_EXTRA_SKILLS_DIR).toContain("ai-ezio");
	});

	it("a passthrough launch (non-intercepted flag) sets HAX_EXTRA_SKILLS_DIR", async () => {
		// `-p <prompt>` now routes through the unified Session + MCP host, so use a
		// generic flag to exercise the raw passthrough spawn layer.
		await main(["--help"]);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const call = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
		expect(call[2].env.HAX_EXTRA_SKILLS_DIR).toContain("ai-ezio");
	});
});
