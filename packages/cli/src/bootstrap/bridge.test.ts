import { describe, expect, it, vi } from "vitest";
import {
	type BridgeDeps,
	hasUserOwnedExport,
	persistBridge,
	renderManagedBlock,
	upsertManagedBlock,
} from "./bridge.js";

describe("managed export block (A/B/C)", () => {
	it("renders a shell-escaped block", () =>
		expect(renderManagedBlock("/tmp/AI Ezio/hax")).toContain(
			`export AI_EZIO_HAX_BIN='/tmp/AI Ezio/hax'`,
		));
	it("appends once, rewrites in place on rerun (finding A)", () => {
		const once = upsertManagedBlock("# rc\n", "/data/ai-ezio/hax");
		expect(upsertManagedBlock(once, "/data/ai-ezio/hax")).toBe(once);
		const moved = upsertManagedBlock(once, "/new/ai-ezio/hax");
		expect(moved.match(/# >>> ai-ezio \(managed\) >>>/g)).toHaveLength(1);
		expect(moved).toContain(`export AI_EZIO_HAX_BIN='/new/ai-ezio/hax'`);
		expect(moved).toContain("# rc");
	});
	it("detects a user-owned export outside the marker (finding C)", () => {
		expect(hasUserOwnedExport("export AI_EZIO_HAX_BIN=/my/own\n")).toBe(true);
		expect(hasUserOwnedExport(renderManagedBlock("/data/ai-ezio/hax"))).toBe(false);
	});
	it("requires a real `export` — a bare assignment is NOT durable (finding 3)", () => {
		// `export AI_EZIO_HAX_BIN=…` is inherited by child processes (whisper's check),
		// so it suppresses the managed block; a bare `AI_EZIO_HAX_BIN=/x` is not.
		expect(hasUserOwnedExport("export AI_EZIO_HAX_BIN=/my/own\n")).toBe(true);
		expect(hasUserOwnedExport("AI_EZIO_HAX_BIN=/x\n")).toBe(false);
	});
});

function harness(over: Partial<BridgeDeps> = {}, initialText = "# rc\n") {
	const profile = { text: initialText };
	const deps: BridgeDeps = {
		resolveHax: () => "/real/hax",
		symlinkPath: () => "/data/ai-ezio/hax",
		ensureSymlink: () => {},
		profilePath: () => "/home/u/.zshrc",
		readFile: () => profile.text,
		writeFile: (_p, s) => {
			profile.text = s;
		},
		env: {} as NodeJS.ProcessEnv,
		...over,
	};
	return { deps, profile };
}

describe("persistBridge", () => {
	it("creates symlink + appends managed block with consent", () => {
		const { deps, profile } = harness();
		const r = persistBridge(true, deps);
		expect(r.action).toBe("created");
		expect(profile.text).toContain(`export AI_EZIO_HAX_BIN='/data/ai-ezio/hax'`);
		expect(r.currentShellHint).toContain("source");
	});
	it("leaves a user-owned profile export untouched (finding C)", () => {
		const { deps, profile } = harness({}, "export AI_EZIO_HAX_BIN=/my/own\n");
		expect(persistBridge(true, deps).action).toBe("left-user-owned");
		expect(profile.text).toBe("export AI_EZIO_HAX_BIN=/my/own\n");
	});
	it("a transient process-env value does NOT suppress persistence (finding C)", () => {
		const { deps, profile } = harness({ env: { AI_EZIO_HAX_BIN: "/tmp/x" } as NodeJS.ProcessEnv });
		const r = persistBridge(true, deps);
		expect(r.action).toBe("created");
		expect(r.transientEnvNote).toContain("temporary");
		expect(profile.text).toContain(`export AI_EZIO_HAX_BIN='/data/ai-ezio/hax'`);
	});
	it("declined consent persists nothing but returns the exact export line", () => {
		const { deps, profile } = harness();
		const r = persistBridge(false, deps);
		expect(r.action).toBe("declined");
		expect(profile.text).toBe("# rc\n");
		expect(r.currentShellHint).toContain(`export AI_EZIO_HAX_BIN='/data/ai-ezio/hax'`);
	});
	it("a bare (non-export) profile line does NOT suppress the managed block (finding 3)", () => {
		const { deps, profile } = harness({}, "AI_EZIO_HAX_BIN=/x\n");
		const r = persistBridge(true, deps);
		expect(r.action).toBe("created"); // not left-user-owned
		expect(profile.text).toContain(`export AI_EZIO_HAX_BIN='/data/ai-ezio/hax'`);
		expect(profile.text).toContain("AI_EZIO_HAX_BIN=/x"); // the user's bare line is preserved
	});
	it("creates the symlink with (resolved hax, symlink path) (finding 7)", () => {
		const ensureSymlink = vi.fn();
		const { deps } = harness({
			resolveHax: () => "/real/hax",
			symlinkPath: () => "/data/ai-ezio/hax",
			ensureSymlink,
		});
		persistBridge(true, deps);
		expect(ensureSymlink).toHaveBeenCalledTimes(1);
		expect(ensureSymlink).toHaveBeenCalledWith("/real/hax", "/data/ai-ezio/hax");
	});
	it("ambiguous profile (null) -> no-profile action + prints the export line (finding 7)", () => {
		const { deps } = harness({ profilePath: () => null });
		const r = persistBridge(true, deps);
		expect(r.action).toBe("no-profile");
		expect(r.currentShellHint).toContain(`export AI_EZIO_HAX_BIN='/data/ai-ezio/hax'`);
	});
});
