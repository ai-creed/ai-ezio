import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { describe, expect, it } from "vitest";
import { EngineExitedError, ProtocolVersionError, Session, TurnError } from "./session.js";

/** Locate the dev-built hax binary by walking up to the repo root. */
function devHax(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		const bin = join(dir, "vendor", "hax", "build", "hax");
		if (existsSync(bin)) return bin;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

const HAX = devHax();
const baseEnv = { ...process.env, HAX_PROVIDER: "mock", HAX_NO_SESSION: "1" };

/** Assert `seq` contains `required` as an in-order subsequence. */
function hasOrderedSubsequence(seq: string[], required: string[]): boolean {
	let i = 0;
	for (const t of seq) if (i < required.length && t === required[i]) i++;
	return i === required.length;
}

// Skips cleanly when the engine isn't built (e.g. CI without the submodule).
describe.runIf(Boolean(HAX))("Session e2e over inherited fds (mock provider)", () => {
	it("emits the full ordered M3a sequence incl. assistant_delta", async () => {
		const events: ProtocolEvent[] = [];
		const session = new Session({ onEvent: (e) => events.push(e) });
		const ready = await session.start({ binary: HAX, env: baseEnv });
		expect(ready.protocol).toMatch(/^\d+\.\d+\.\d+$/);

		const result = await session.submitAndWait("say hello");
		session.close();

		const seq = events.map((e) => e.type);
		expect(
			hasOrderedSubsequence(seq, [
				"ready",
				"user_turn_started",
				"assistant_turn_started",
				"assistant_delta",
				"assistant_turn_finished",
				"idle",
			]),
		).toBe(true);

		const deltas = events.filter((e) => e.type === "assistant_delta");
		expect(deltas.length).toBeGreaterThan(0);
		// authoritative handback, and deltas concatenate to it
		expect(result.content).toContain("say hello");
		const joined = deltas.map((e) => (e.type === "assistant_delta" ? e.text : "")).join("");
		expect(joined.trim()).toBe(result.content.trim());
	}, 20000);

	it("interrupt aborts a live turn and returns to idle", async () => {
		// A slow mock turn (2.5s delay before any text); the stream tick polls the
		// control fd every ~50ms during the delay, so `interrupt` aborts it.
		const dir = mkdtempSync(join(tmpdir(), "ezio-mock-"));
		const script = join(dir, "slow.mock");
		writeFileSync(script, "delay 2500\ntext SHOULD_NOT_APPEAR\nend-turn\n");

		const events: ProtocolEvent[] = [];
		const session = new Session({ onEvent: (e) => events.push(e) });
		await session.start({ binary: HAX, env: { ...baseEnv, HAX_MOCK_SCRIPT: script } });

		session.submit("go");
		await session.waitForEvent("assistant_turn_started");
		const t0 = Date.now();
		session.interrupt();
		await session.waitForEvent("idle");
		const elapsed = Date.now() - t0;
		session.close();
		rmSync(dir, { recursive: true, force: true });

		// Aborted well before the full 2.5s delay, and the scripted text never shipped.
		expect(elapsed).toBeLessThan(2000);
		expect(
			events.some((e) => e.type === "assistant_delta" && e.text.includes("SHOULD_NOT_APPEAR")),
		).toBe(false);
	}, 20000);

	it("handles a second turn (idle is the safe re-submit point)", async () => {
		const session = new Session();
		await session.start({ binary: HAX, env: baseEnv });
		const a = await session.submitAndWait("first");
		const b = await session.submitAndWait("second");
		expect(a.content).toContain("first");
		expect(b.content).toContain("second");
		session.close();
	}, 20000);

	it("surfaces tool_call_started/finished for a tool turn (mock backtick)", async () => {
		const events: ProtocolEvent[] = [];
		const session = new Session({ onEvent: (e) => events.push(e) });
		await session.start({ binary: HAX, env: baseEnv });
		await session.submitAndWait("run `ls`"); // backtick arg → mock bash tool call
		session.close();

		const started = events.find((e) => e.type === "tool_call_started");
		const finished = events.find((e) => e.type === "tool_call_finished");
		expect(started?.type).toBe("tool_call_started");
		expect(finished?.type).toBe("tool_call_finished");
		if (started?.type === "tool_call_started" && finished?.type === "tool_call_finished") {
			expect(started.name).toBe("bash");
			expect(finished.name).toBe("bash");
			expect(finished.status).toBe("ok");
			expect(finished.callId).toBe(started.callId); // matching callId
		}
		// started precedes finished
		const seq = events.map((e) => e.type);
		expect(seq.indexOf("tool_call_started")).toBeLessThan(seq.indexOf("tool_call_finished"));
	}, 20000);
});

// Error / fatal-EOF / version-mismatch handling, driven by a deterministic Node
// fake engine (no hax needed) — always runs.
const FAKE = fileURLToPath(new URL("../test-fixtures/fake-engine.mjs", import.meta.url));
chmodSync(FAKE, 0o755);
const fakeEnv = (mode: string) => ({ ...process.env, FAKE_ENGINE_MODE: mode });

describe("Session error / fatal-EOF / version handling (fake engine)", () => {
	it("turn-scoped error drains to idle, throws TurnError, and stays usable", async () => {
		const session = new Session();
		await session.start({ binary: FAKE, env: fakeEnv("error") });
		// first turn errors → TurnError after draining to idle
		await expect(session.submitAndWait("one")).rejects.toBeInstanceOf(TurnError);
		// session settled at idle → a subsequent turn succeeds
		const second = await session.submitAndWait("two");
		expect(second.content).toContain("two");
		session.close();
	}, 10000);

	it("fatal fd-3 EOF mid-turn rejects with EngineExitedError (not TurnError)", async () => {
		const session = new Session();
		await session.start({ binary: FAKE, env: fakeEnv("fatal-on-submit") });
		await expect(session.submitAndWait("go")).rejects.toBeInstanceOf(EngineExitedError);
		session.close();
	}, 10000);

	it("fatal EOF before ready rejects start() with EngineExitedError", async () => {
		const session = new Session();
		await expect(
			session.start({ binary: FAKE, env: fakeEnv("fatal-before-ready") }),
		).rejects.toBeInstanceOf(EngineExitedError);
		session.close();
	}, 10000);

	it("unsupported protocol major rejects with ProtocolVersionError and tears down", async () => {
		const session = new Session();
		await expect(session.start({ binary: FAKE, env: fakeEnv("bad-major") })).rejects.toBeInstanceOf(
			ProtocolVersionError,
		);
		// teardown is idempotent / safe to call again
		session.close();
	}, 10000);
});
