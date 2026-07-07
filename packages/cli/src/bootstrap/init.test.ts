import { describe, expect, it, vi } from "vitest";
import type { Environment } from "./detect.js";
import { type InitDeps, parseInitArgs, remediationFor, runInit } from "./init.js";

const absent: Environment = {
	isTTY: true,
	isCI: false,
	manager: "npm",
	peers: {
		cortex: { name: "cortex", bin: "ai-cortex", present: false, version: null },
		whisper: { name: "whisper", bin: "whisper", present: false, version: null },
	},
};
const present = (over: Partial<Environment["peers"]> = {}): Environment => ({
	...absent,
	peers: {
		cortex: { name: "cortex", bin: "ai-cortex", present: true, version: "0.14.2" },
		whisper: { name: "whisper", bin: "whisper", present: true, version: "0.5.5" },
		...over,
	},
});

function deps(env: Environment, over: Partial<InitDeps> = {}): InitDeps {
	return {
		detect: () => env,
		checkCompat: () => ({ state: "compatible" }),
		askYesNo: vi.fn(async () => true),
		installPeer: vi.fn(() => ({ ok: true })),
		classifyCortex: vi.fn(() => "missing"),
		backupMalformedMcp: vi.fn(() => ({ ok: true, path: null })),
		applyCortex: vi.fn(() => true),
		persistBridge: vi.fn(() => ({
			action: "created" as const,
			currentShellHint: "source ~/.zshrc",
		})),
		whisperPrereqGuidance: vi.fn(() => []),
		cortexHookGuidance: vi.fn(() => []),
		writeMarker: vi.fn(),
		out: vi.fn(),
		...over,
	};
}

describe("parseInitArgs", () => {
	it("defaults peers on; flags toggle off; --yes/--reconfigure parse", () => {
		expect(parseInitArgs([])).toEqual({
			yes: false,
			cortex: true,
			whisper: true,
			reconfigure: false,
		});
		expect(parseInitArgs(["--yes", "--no-whisper", "--reconfigure"])).toEqual({
			yes: true,
			cortex: true,
			whisper: false,
			reconfigure: true,
		});
	});
});

describe("runInit gating", () => {
	it("--yes with absent peers installs both, wires cortex + bridge, writes marker", async () => {
		const d = deps(absent);
		await runInit({ yes: true, cortex: true, whisper: true, reconfigure: false }, d);
		expect(d.installPeer).toHaveBeenCalledTimes(2);
		expect(d.applyCortex).toHaveBeenCalled();
		expect(d.persistBridge).toHaveBeenCalledWith(true);
		expect(d.writeMarker).toHaveBeenCalled();
	});

	it("never reinstalls a present peer", async () => {
		const d = deps(present());
		await runInit({ yes: true, cortex: true, whisper: true, reconfigure: false }, d);
		expect(d.installPeer).not.toHaveBeenCalled();
	});

	it("--no-cortex skips cortex wiring entirely", async () => {
		const d = deps(present());
		await runInit({ yes: true, cortex: false, whisper: true, reconfigure: false }, d);
		expect(d.applyCortex).not.toHaveBeenCalled();
		expect(d.classifyCortex).not.toHaveBeenCalled();
	});

	it("--no-whisper skips the bridge entirely", async () => {
		const d = deps(present());
		await runInit({ yes: true, cortex: true, whisper: false, reconfigure: false }, d);
		expect(d.persistBridge).not.toHaveBeenCalled();
	});

	it("a failed install wires nothing for that peer AND prints targeted remediation", async () => {
		const out = vi.fn();
		const d = deps(absent, {
			installPeer: vi.fn(() => ({ ok: false, error: "npm ERR! EACCES permission denied" })),
			out,
		});
		await runInit({ yes: true, cortex: true, whisper: true, reconfigure: false }, d);
		expect(d.applyCortex).not.toHaveBeenCalled();
		expect(d.persistBridge).not.toHaveBeenCalled();
		const text = out.mock.calls.flat().join("\n");
		expect(text).toContain("EACCES");
		expect(text).toContain("version manager"); // targeted, not just the raw error
	});

	it("non-TTY without --yes never prompts, installs nothing, wires present cortex but only PRINTS the bridge line (no profile write)", async () => {
		const ask = vi.fn(async () => true);
		const persistBridge = vi.fn(() => ({
			action: "declined" as const,
			currentShellHint: "export AI_EZIO_HAX_BIN='…'",
		}));
		const d = deps({ ...present(), isTTY: false }, { askYesNo: ask, persistBridge });
		await runInit({ yes: false, cortex: true, whisper: true, reconfigure: false }, d);
		expect(ask).not.toHaveBeenCalled(); // never hangs
		expect(d.installPeer).not.toHaveBeenCalled();
		expect(d.applyCortex).toHaveBeenCalled(); // present cortex, mcp.json is ezio-owned
		expect(persistBridge).toHaveBeenCalledWith(false); // no consent -> print only
	});

	it("prints below-min guidance for a present-but-old peer and still wires it (no upgrade)", async () => {
		const out = vi.fn();
		const d = deps(
			present({ cortex: { name: "cortex", bin: "ai-cortex", present: true, version: "0.10.0" } }),
			{
				checkCompat: (p) =>
					p === "cortex"
						? { state: "below-min", min: "0.14.0", guide: "upgrade ai-cortex" }
						: { state: "compatible" },
				out,
				installPeer: vi.fn(() => ({ ok: true })),
			},
		);
		await runInit({ yes: true, cortex: true, whisper: true, reconfigure: false }, d);
		expect(out.mock.calls.flat().join("\n")).toContain("upgrade ai-cortex");
		expect(d.installPeer).not.toHaveBeenCalled(); // present -> never upgraded
		expect(d.applyCortex).toHaveBeenCalled();
	});

	it("offers (default no) to migrate a valid hardcoded cortex entry; leaves it when declined", async () => {
		const ask = vi.fn(async () => false);
		const d = deps(present(), { classifyCortex: () => "valid-hardcoded", askYesNo: ask });
		await runInit({ yes: false, cortex: true, whisper: false, reconfigure: false }, d);
		expect(d.applyCortex).not.toHaveBeenCalled();
	});

	it("malformed mcp.json is ALWAYS reconciled (no decline path): backs up + repairs, never asks (finding 2)", async () => {
		const out = vi.fn();
		const ask = vi.fn(async () => false); // would decline if asked — but it must NOT be asked
		const applyCortex = vi.fn(() => true);
		const backupMalformedMcp = vi.fn(() => ({ ok: true, path: "/c/mcp.json.bak" }));
		const d = deps(present(), {
			classifyCortex: () => "malformed",
			backupMalformedMcp,
			applyCortex,
			askYesNo: ask,
			out,
		});
		await runInit({ yes: false, cortex: true, whisper: false, reconfigure: false }, d);
		expect(backupMalformedMcp).toHaveBeenCalled(); // backed up before writing
		expect(applyCortex).toHaveBeenCalled(); // reconciled regardless of consent
		// no "Repair …?" prompt for the malformed kind (it has no decline path)
		expect(ask.mock.calls.flat().some((a) => String(a).includes("Repair"))).toBe(false);
		const text = out.mock.calls.flat().join("\n");
		expect(text).toContain("backed up malformed mcp.json to /c/mcp.json.bak");
		expect(text).toContain("wrote a fresh portable cortex entry");
		expect(text).not.toContain("left"); // never "left as-is"
	});

	it("malformed mcp.json with an UNRESOLVABLE cortex still reports the backup + prints the intended entry (finding 2)", async () => {
		const out = vi.fn();
		// applyCortex returns false (skipped); the backup is a distinct step that succeeded.
		const d = deps(present(), {
			classifyCortex: () => "malformed",
			backupMalformedMcp: vi.fn(() => ({ ok: true, path: "/c/mcp.json.bak" })),
			applyCortex: vi.fn(() => false),
			out,
		});
		await runInit({ yes: true, cortex: true, whisper: false, reconfigure: false }, d);
		const text = out.mock.calls.flat().join("\n");
		expect(text).toContain("backed up malformed mcp.json to /c/mcp.json.bak");
		expect(text).toContain(`{"command":"ai-cortex","args":["mcp"]}`); // intended entry printed
		expect(text).not.toContain("left"); // never "left as-is"
	});

	it("malformed mcp.json whose BACKUP FAILS: no success message, file preserved, no fresh write (finding 2 §5.4)", async () => {
		const out = vi.fn();
		const applyCortex = vi.fn(() => true);
		const d = deps(present(), {
			classifyCortex: () => "malformed",
			backupMalformedMcp: vi.fn(() => ({ ok: false, error: "EACCES: permission denied" })),
			applyCortex,
			out,
		});
		await runInit({ yes: true, cortex: true, whisper: false, reconfigure: false }, d);
		const text = out.mock.calls.flat().join("\n");
		// honest failure guidance, naming the cause and a retry
		expect(text).toContain("could not back up malformed mcp.json");
		expect(text).toContain("EACCES");
		expect(text).toContain("left it untouched");
		expect(text).toContain("ai-ezio init --reconfigure");
		// NEVER a false success and NEVER an overwrite of the unsaved malformed file
		expect(text).not.toContain("backed up malformed mcp.json to");
		expect(text).not.toContain("wrote a fresh portable cortex entry");
		expect(applyCortex).not.toHaveBeenCalled();
	});

	it("unreadable mcp.json degrades to guidance, skips wiring entirely — no backup/write/false claim (finding 1 §6)", async () => {
		const out = vi.fn();
		const backupMalformedMcp = vi.fn(() => ({ ok: true, path: null }));
		const applyCortex = vi.fn(() => true);
		const d = deps(present(), {
			classifyCortex: () => "unreadable",
			backupMalformedMcp,
			applyCortex,
			out,
		});
		await runInit({ yes: true, cortex: true, whisper: false, reconfigure: false }, d);
		const text = out.mock.calls.flat().join("\n");
		expect(text).toContain("could not read mcp.json");
		expect(text).toContain("ai-ezio init --reconfigure");
		expect(backupMalformedMcp).not.toHaveBeenCalled(); // NO backup
		expect(applyCortex).not.toHaveBeenCalled(); // NO write
		expect(text).not.toContain("added"); // no false "added/repaired" claim
		expect(text).not.toContain("repaired");
		expect(text).not.toContain("backed up");
	});

	it("prints an ACCURATE summary (not 'added') when applyCortex skips because nothing resolved", async () => {
		const out = vi.fn();
		const d = deps(present(), {
			classifyCortex: () => "missing",
			applyCortex: vi.fn(() => false),
			out,
		});
		await runInit({ yes: true, cortex: true, whisper: false, reconfigure: false }, d);
		const text = out.mock.calls.flat().join("\n");
		expect(text).toContain("could not resolve");
		expect(text).not.toContain("added portable cortex entry");
	});

	it("prints whisper prereq + cortex hook guidance when those peers are wired", async () => {
		const out = vi.fn();
		const d = deps(present(), {
			whisperPrereqGuidance: () => ["set ANTHROPIC_API_KEY"],
			cortexHookGuidance: () => ["cortex hooks…"],
			out,
		});
		await runInit({ yes: true, cortex: true, whisper: true, reconfigure: false }, d);
		const text = out.mock.calls.flat().join("\n");
		expect(text).toContain("set ANTHROPIC_API_KEY");
		expect(text).toContain("cortex hooks");
	});

	it("first-run defaults: no flags in a TTY fires BOTH peer offers with default-yes (required regression)", async () => {
		const calls: Array<{ q: string; d: boolean }> = [];
		const ask = vi.fn(async (q: string, dft: boolean) => {
			calls.push({ q, d: dft });
			return true;
		});
		const d = deps(absent, { askYesNo: ask });
		await runInit(parseInitArgs([]), d); // {yes:false, cortex:true, whisper:true} -> interactive
		const offers = calls.filter((c) => c.q.startsWith("Install "));
		expect(offers.map((c) => c.q)).toEqual(["Install ai-cortex?", "Install ai-whisper?"]);
		expect(offers.every((c) => c.d === true)).toBe(true); // default-yes for BOTH peers
	});
});

describe("remediationFor (spec §6 targeted guidance)", () => {
	it("EACCES -> version-manager/prefix guidance", () => {
		expect(remediationFor("ai-cortex", "npm ERR! EACCES").join("\n")).toContain("version manager");
	});
	it("native build -> build-tools guidance", () => {
		expect(remediationFor("ai-whisper", "node-gyp rebuild failed").join("\n")).toContain(
			"build tools",
		);
	});
	it("always ends with a concrete retry line", () => {
		expect(remediationFor("ai-cortex", "weird").some((l) => l.includes("retry"))).toBe(true);
	});
});
