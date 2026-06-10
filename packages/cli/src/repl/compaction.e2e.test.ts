/**
 * M11 full-cycle integration: the real hax engine (mock provider) driven
 * through the cli's buildCompactor wiring. Proves the spec's exclusion gate —
 * post-compact history is summary + the last K real turns with no trace of the
 * summarization exchange — plus post-compact health and the legacy
 * `submit(); waitForEvent("idle")` regression against a real engine.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPACTION_DEFAULTS, Session } from "@ai-ezio/harness";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { buildCompactor } from "./compaction-wiring.js";

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

// Skips cleanly when the engine isn't built (e.g. CI without the submodule).
describe.runIf(Boolean(HAX))("compaction full cycle over the real engine", () => {
	it("auto-compacts: summary + last K real turns, no summarize-exchange residue", async () => {
		const transcript = join(mkdtempSync(join(tmpdir(), "ezio-compact-e2e-")), "transcript.txt");
		const tee: ProtocolEvent[] = [];
		const session = new Session({ onEvent: (e) => tee.push(e) });
		await session.start({
			binary: HAX,
			env: {
				...process.env,
				HAX_PROVIDER: "mock",
				HAX_NO_SESSION: "1",
				HAX_TRANSCRIPT: transcript,
			},
		});

		await session.submitAndWait("MARKER-ONE");
		await session.submitAndWait("MARKER-TWO");
		await session.submitAndWait("MARKER-THREE");

		const chrome: string[] = [];
		const wired = buildCompactor({
			session,
			config: { ...COMPACTION_DEFAULTS }, // keepLastTurns 2, threshold 0.8
			write: (s) => chrome.push(s),
		});
		wired.compactor.noteUsage({ contextTokens: 90, contextLimit: 100 });

		// Legacy-pattern regression, concurrent with the cycle: the unawaited
		// submit is gate-deferred and the bare idle-waiter must resolve on the
		// queued turn's OWN idle, never a cycle-internal one.
		const cycle = wired.compactor.maybeAutoCompact();
		void session.submit("MARKER-QUEUED");
		const legacyIdle = session.waitForEvent("idle");

		const outcome = await cycle;
		expect(outcome.kind).toBe("compacted");
		await legacyIdle; // resolves only once the queued turn ran post-cycle

		const types = tee.map((e) => e.type);
		const compactedAt = types.indexOf("compacted");
		const queuedTurnAt = types.lastIndexOf("user_turn_started");
		expect(compactedAt).toBeGreaterThan(-1);
		expect(queuedTurnAt).toBeGreaterThan(compactedAt);

		// Post-compact health: another real turn completes.
		const after = await session.submitAndWait("MARKER-FOUR");
		expect(after.content).toContain("MARKER-FOUR");

		const t = readFileSync(transcript, "utf8");
		expect(t).toContain("[Context summary — session compacted]");
		expect(t).toContain("MARKER-TWO"); // kept tail (last 2 real turns)
		expect(t).toContain("MARKER-THREE");
		expect(t).toContain("MARKER-QUEUED"); // the deferred turn, post-compact
		expect(t).toContain("MARKER-FOUR");
		expect(t).not.toContain("MARKER-ONE"); // summarized away
		// Exclusion gate: the summarize exchange was dropped. The mock provider
		// echoes its input, so the instruction's distinctive phrase legitimately
		// appears ONCE — inside the composed summary block. A wrongly-kept
		// exchange would put it in the transcript ≥ 2 more times (the
		// instruction user turn + its echoed reply).
		const phrase = /dense continuation brief/g;
		expect((t.match(phrase) ?? []).length).toBe(1);

		expect(chrome.some((c) => c.includes("compacting…"))).toBe(true);
		expect(chrome.some((c) => c.includes("✦ compacted"))).toBe(true);
		session.close();
	}, 20000);
});
