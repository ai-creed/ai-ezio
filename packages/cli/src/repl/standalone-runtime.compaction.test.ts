import type { Session, SessionOptions } from "@ai-ezio/harness";
import { describe, expect, it } from "vitest";
import { mountedSessionOptions, runOneShot, runStandalone } from "./standalone-runtime.js";

describe("mountedSessionOptions", () => {
	it("pins engine auto-compaction off for the main session", () => {
		expect(mountedSessionOptions().engineEnvOverrides?.HAX_COMPACT_AUTO).toBe("0");
	});

	it("preserves base options while pinning the override", () => {
		const onEvent = (): void => {};
		const opts = mountedSessionOptions({ onEvent, compactTimeoutMs: 5 });
		expect(opts.onEvent).toBe(onEvent);
		expect(opts.compactTimeoutMs).toBe(5);
		expect(opts.engineEnvOverrides?.HAX_COMPACT_AUTO).toBe("0");
	});
});

// A spy makeSession that records the options the production site constructs the
// Session with, then throws a sentinel to short-circuit before any spawn/teardown.
// The default seam is `new Session(o)` (no override), so a captured override proves
// the call site itself routed through mountedSessionOptions.
function captureMakeSession(): {
	makeSession: (o: SessionOptions) => Session;
	stop: Error;
	captured: () => SessionOptions | undefined;
} {
	const stop = new Error("captured-after-construct");
	let captured: SessionOptions | undefined;
	return {
		stop,
		captured: () => captured,
		makeSession: (o) => {
			captured = o;
			throw stop;
		},
	};
}

describe("main-session construction is wired through mountedSessionOptions", () => {
	it("runOneShot constructs its Session with HAX_COMPACT_AUTO=0", async () => {
		const spy = captureMakeSession();
		await expect(
			runOneShot("hi", { out: () => {}, err: () => {}, makeSession: spy.makeSession }),
		).rejects.toBe(spy.stop);
		expect(spy.captured()?.engineEnvOverrides?.HAX_COMPACT_AUTO).toBe("0");
	});

	it("runStandalone constructs its Session with HAX_COMPACT_AUTO=0", async () => {
		const spy = captureMakeSession();
		await expect(runStandalone({ makeSession: spy.makeSession })).rejects.toBe(spy.stop);
		expect(spy.captured()?.engineEnvOverrides?.HAX_COMPACT_AUTO).toBe("0");
	});
});
