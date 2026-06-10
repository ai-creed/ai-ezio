import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock spawn so we can inspect the actual launch the CLI performs (spec requires
// asserting the spawn layer, not just the pure launchEnv/mountStdio helpers).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Mock the self-mount runtime so resume-routing tests assert what main() forwards
// without spinning up the real Session / MCP host.
const { runStandaloneMock } = vi.hoisted(() => ({ runStandaloneMock: vi.fn() }));
vi.mock("./repl/standalone-runtime.js", () => ({
	runStandalone: runStandaloneMock,
	runOneShot: vi.fn(),
}));

// Mock the resume picker so bare-`--resume` routing is asserted without real
// stdin / a hax --list-sessions spawn.
const { runResumePickerMock } = vi.hoisted(() => ({ runResumePickerMock: vi.fn() }));
vi.mock("./repl/resume-picker.js", () => ({
	runResumePicker: runResumePickerMock,
	spawnListSessions: vi.fn(() => Promise.resolve("[]")),
}));

import { type InitDeps, parseInitArgs, runInit } from "./bootstrap/init.js";
import type { Environment } from "./bootstrap/detect.js";
import { isBootstrapped, writeMarker } from "./bootstrap/marker.js";
import { main, maybeRunFirstRun, shouldRunFirstRun } from "./cli.js";

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

describe("ai-ezio resume routing", () => {
	const savedBin = process.env.AI_EZIO_HAX_BIN;
	let restoreTTY: () => void;

	function setTTY(stdin: boolean, stdout: boolean): void {
		const sIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const sOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
		restoreTTY = () => {
			if (sIn) Object.defineProperty(process.stdin, "isTTY", sIn);
			if (sOut) Object.defineProperty(process.stdout, "isTTY", sOut);
		};
	}

	beforeEach(() => {
		process.env.AI_EZIO_HAX_BIN = process.execPath;
		spawnMock.mockReset();
		runStandaloneMock.mockReset();
		runStandaloneMock.mockResolvedValue(0);
		runResumePickerMock.mockReset();
		restoreTTY = () => {};
	});

	afterEach(() => {
		restoreTTY();
		if (savedBin === undefined) delete process.env.AI_EZIO_HAX_BIN;
		else process.env.AI_EZIO_HAX_BIN = savedBin;
	});

	it("routes --continue to the self-mount with resumeArgs, not the passthrough", async () => {
		setTTY(true, true);
		const code = await main(["--continue"]);
		expect(code).toBe(0);
		expect(runStandaloneMock).toHaveBeenCalledWith({ resumeArgs: ["--continue"] });
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("routes --resume=ID to the self-mount with the id flag", async () => {
		setTTY(true, true);
		await main(["--resume=abc123"]);
		expect(runStandaloneMock).toHaveBeenCalledWith({ resumeArgs: ["--resume=abc123"] });
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("opens the picker on bare --resume and resumes the chosen id", async () => {
		setTTY(true, true);
		runResumePickerMock.mockResolvedValue("chosen-id");
		await main(["--resume"]);
		expect(runResumePickerMock).toHaveBeenCalledTimes(1);
		expect(runStandaloneMock).toHaveBeenCalledWith({ resumeArgs: ["--resume=chosen-id"] });
	});

	it("exits cleanly (0) when the picker is cancelled / empty", async () => {
		setTTY(true, true);
		runResumePickerMock.mockResolvedValue(undefined);
		const code = await main(["--resume"]);
		expect(code).toBe(0);
		expect(runStandaloneMock).not.toHaveBeenCalled();
	});

	it("does not intercept resume when not a TTY (falls through to passthrough)", async () => {
		setTTY(false, false);
		const child = {
			on: vi.fn((event: string, cb: (code: number | null, sig: null) => void) => {
				if (event === "exit") setImmediate(() => cb(0, null));
				return child;
			}),
		};
		spawnMock.mockReturnValue(child);
		await main(["--continue"]);
		expect(runStandaloneMock).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledTimes(1); // raw hax passthrough
	});
});

describe("first-run gate predicate (finding E)", () => {
	it("true on bare TTY launch with no marker; false otherwise", () => {
		expect(shouldRunFirstRun([], { isTTY: true, bootstrapped: false })).toBe(true);
		expect(shouldRunFirstRun([], { isTTY: true, bootstrapped: true })).toBe(false);
		expect(shouldRunFirstRun([], { isTTY: false, bootstrapped: false })).toBe(false);
		expect(shouldRunFirstRun(["-p", "hi"], { isTTY: true, bootstrapped: false })).toBe(false);
		expect(shouldRunFirstRun(["init"], { isTTY: true, bootstrapped: false })).toBe(false);
	});
});

describe("first-run dispatcher (finding E — actual dispatch + suppression)", () => {
	it("invokes the wizard once on first launch, then is suppressed by the marker", async () => {
		let bootstrapped = false;
		const runWizard = vi.fn(async () => {
			bootstrapped = true; // runInitCli writes the marker
		});
		await maybeRunFirstRun([], {
			isTTY: () => true,
			isBootstrapped: () => bootstrapped,
			runWizard,
		});
		await maybeRunFirstRun([], {
			isTTY: () => true,
			isBootstrapped: () => bootstrapped,
			runWizard,
		});
		expect(runWizard).toHaveBeenCalledTimes(1);
	});
	it("does not invoke the wizard when not a TTY", async () => {
		const runWizard = vi.fn(async () => {});
		await maybeRunFirstRun([], { isTTY: () => false, isBootstrapped: () => false, runWizard });
		expect(runWizard).not.toHaveBeenCalled();
	});

	it("drives the wizard through the dispatcher using the REAL marker module (no in-memory boolean): first launch fires BOTH default-yes offers + writes the on-disk marker, second is suppressed by reading it", async () => {
		const home = mkdtempSync(join(tmpdir(), "ezio-fr-"));
		const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } as NodeJS.ProcessEnv;
		const absentEnv: Environment = {
			isTTY: true,
			isCI: false,
			manager: "npm",
			peers: {
				cortex: { name: "cortex", bin: "ai-cortex", present: false, version: null },
				whisper: { name: "whisper", bin: "whisper", present: false, version: null },
			},
		};
		const offers: Array<{ q: string; d: boolean }> = [];
		const wizardDeps: InitDeps = {
			detect: () => absentEnv,
			checkCompat: () => ({ state: "compatible" }),
			askYesNo: async (q, d) => {
				offers.push({ q, d });
				return true;
			},
			installPeer: () => ({ ok: true }),
			classifyCortex: () => "missing",
			applyCortex: () => true,
			persistBridge: () => ({ action: "created", currentShellHint: "source ~/.zshrc" }),
			whisperPrereqGuidance: () => [],
			cortexHookGuidance: () => [],
			// REAL marker write — through the same markerPath module the gate reads.
			writeMarker: () =>
				writeMarker(env, {
					mkdirp: (d) => mkdirSync(d, { recursive: true }),
					writeFile: (p, s) => writeFileSync(p, s),
				}),
			out: () => {},
		};
		const runWizard = vi.fn(async () => {
			await runInit(parseInitArgs([]), wizardDeps);
		});
		// isBootstrapped reads the REAL on-disk marker (not an in-memory flag), so a
		// regression in the marker path or write would surface here.
		const fr = {
			isTTY: () => true,
			isBootstrapped: () => isBootstrapped(env, existsSync),
			runWizard,
		};
		await maybeRunFirstRun([], fr); // first: no marker -> wizard runs + writes the on-disk marker
		await maybeRunFirstRun([], fr); // second: real marker present -> suppressed
		rmSync(home, { recursive: true, force: true });
		expect(runWizard).toHaveBeenCalledTimes(1);
		const installOffers = offers.filter((o) => o.q.startsWith("Install "));
		expect(installOffers.map((o) => o.q)).toEqual(["Install ai-cortex?", "Install ai-whisper?"]);
		expect(installOffers.every((o) => o.d === true)).toBe(true); // both default-yes, at the dispatcher level
	});
});
