import { describe, expect, it, vi } from "vitest";

// Mock the real spawn so we can inspect the actual call spawnHax makes (the spec
// requires asserting the launch layer, not just the pure helper output).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { aiEzioGlobalSkillsDir } from "./skills-dir.js";
import { spawnHax } from "./spawn.js";

describe("spawnHax launch layer", () => {
	it("the real spawn call passes --mount-mode and sets HAX_EXTRA_SKILLS_DIR", () => {
		spawnMock.mockReturnValue({ stdio: [null, null, null, null, null] });
		const base = { XDG_CONFIG_HOME: "/xdg", FOO: "bar" } as NodeJS.ProcessEnv;

		spawnHax({ binary: "/fake/hax", env: base });

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const call = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
		const [bin, args, opts] = call;
		expect(bin).toBe("/fake/hax");
		expect(args).toContain("--mount-mode"); // chrome-suppressed mounted posture
		expect(args).toContain("--protocol-fd=3");
		expect(args).toContain("--control-fd=4");
		// the actual child env carries the engine-visibility bridge
		expect(opts.env.HAX_EXTRA_SKILLS_DIR).toBe(aiEzioGlobalSkillsDir(base));
		expect(opts.env.FOO).toBe("bar"); // base env preserved
	});

	it("exports HAX_TRANSCRIPT on the real spawn call when transcriptPath is set", () => {
		spawnMock.mockReturnValue({ stdio: [null, null, null, null, null] });
		spawnHax({ binary: "/fake/hax", env: {} as NodeJS.ProcessEnv, transcriptPath: "/t/x.txt" });
		// `.at(-1)`: the mock is not reset between tests, so read THIS test's call.
		const [, , opts] = spawnMock.mock.calls.at(-1) as [string, string[], { env: NodeJS.ProcessEnv }];
		expect(opts.env.HAX_TRANSCRIPT).toBe("/t/x.txt");
	});

	it("omits HAX_TRANSCRIPT when no transcriptPath is set", () => {
		spawnMock.mockReturnValue({ stdio: [null, null, null, null, null] });
		spawnHax({ binary: "/fake/hax", env: {} as NodeJS.ProcessEnv });
		const [, , opts] = spawnMock.mock.calls.at(-1) as [string, string[], { env: NodeJS.ProcessEnv }];
		expect(opts.env.HAX_TRANSCRIPT).toBeUndefined();
	});
});
