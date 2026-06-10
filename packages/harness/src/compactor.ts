/**
 * Compaction policy owner (M11, spec §3). All intelligence here; the engine
 * only executes the generic `compact` control. Injected callbacks keep
 * layering clean: no mcp-host, no session-recorder imports — the wiring layer
 * (CLI / adapter) supplies cortex rehydration and the recorder-derived digest.
 */
import type { CompactionConfig } from "./config.js";
import type { CompactResult, ExclusiveSession } from "./session.js";

/** The slice of Session the Compactor needs (kept narrow for testability). */
export interface CompactorSession {
	runExclusive<T>(fn: (s: ExclusiveSession) => Promise<T>): Promise<T>;
}

export interface CompactorOptions {
	session: CompactorSession;
	config: CompactionConfig;
	/** Cortex rehydration block (wired by CLI/adapter via mcp-host). */
	rehydrate?: () => Promise<string | null>;
	/** Deterministic digest source (wired by CLI/adapter from the recorder). */
	fallbackDigest?: () => Promise<string | null>;
	/** Surface a user-visible warning/info line (CLI chrome, adapter log). */
	onNote?: (line: string) => void;
	/** Fired when a cycle actually begins (after the in-gate re-check passes) —
	 * the surface uses it to switch to "compacting…" chrome / suppression. */
	onCycleStart?: () => void;
}

const REHYDRATE_MAX_CHARS = 4000;

const SUMMARIZE_INSTRUCTION = [
	"Summarize this conversation so far into a dense continuation brief for",
	"yourself. Cover: the task and its current state, key decisions made and",
	"why, files touched (exact paths), commands run and their outcomes, open",
	"threads, and concrete next steps. Be specific; omit pleasantries.",
].join(" ");

export type CompactOutcome =
	| { kind: "compacted"; result: CompactResult }
	| { kind: "skipped"; reason: "in-progress" | "not-armed" }
	| { kind: "failed"; reason: string };

export class Compactor {
	private lastCtx?: number;
	private lastLimit?: number;
	private inProgress = false;
	/** Re-arm floor after a failed cycle: ctx must exceed this to auto-retry. */
	private rearmCtx?: number;

	constructor(private readonly opts: CompactorOptions) {}

	/** Feed each assistant_turn_finished.usage here (harness event tee). */
	noteUsage(usage?: { contextTokens?: number; contextLimit?: number }): void {
		if (usage?.contextTokens !== undefined) this.lastCtx = usage.contextTokens;
		if (usage?.contextLimit !== undefined) this.lastLimit = usage.contextLimit;
	}

	/** Auto trigger — call at each idle. Cycles when armed; no-op otherwise. */
	async maybeAutoCompact(): Promise<CompactOutcome> {
		if (!this.armed()) return { kind: "skipped", reason: "not-armed" };
		return this.run(true);
	}

	/** Auto-compact is armed: enabled, limit known, fullness >= threshold, and
	 * past the re-arm floor of a prior failed cycle. */
	private armed(): boolean {
		const { auto, threshold } = this.opts.config;
		if (!auto || this.lastCtx === undefined || !this.lastLimit) return false;
		if (this.rearmCtx !== undefined && this.lastCtx <= this.rearmCtx) return false;
		return this.lastCtx / this.lastLimit >= threshold;
	}

	/** Manual trigger (/compact, adapter). Runs regardless of the threshold. */
	async compactNow(): Promise<CompactOutcome> {
		return this.run(false);
	}

	private async run(requireArmed: boolean): Promise<CompactOutcome> {
		if (this.inProgress) return { kind: "skipped", reason: "in-progress" };
		this.inProgress = true;
		try {
			return await this.opts.session.runExclusive(async (s) => {
				// Spec §2: the auto trigger re-checks its arming condition AFTER
				// acquiring the gate — a turn that ran while we waited changed
				// both idleness and fullness. Manual compaction skips the
				// threshold.
				if (requireArmed && !this.armed()) {
					return { kind: "skipped", reason: "not-armed" } as const;
				}
				return this.cycle(s);
			});
		} finally {
			this.inProgress = false;
		}
	}

	private async cycle(s: ExclusiveSession): Promise<CompactOutcome> {
		this.opts.onCycleStart?.();
		let summary: string | null = null;
		// True once the summarize submit reached the engine — even a failed
		// turn entered history (the engine absorbs aborted turns; a pre-stream
		// failure leaves a dangling user message), so the compact must drop it.
		let submitted = false;
		try {
			submitted = true;
			summary = (await s.submitAndWait(SUMMARIZE_INSTRUCTION)).content || null;
		} catch {
			summary = null; // fall through to the digest
		}
		if (!summary) {
			summary = (await this.opts.fallbackDigest?.()) ?? null;
			if (!summary) {
				this.rearmCtx = this.armFloor();
				this.opts.onNote?.("compaction aborted: no summary and no digest available");
				return { kind: "failed", reason: "no summary source" };
			}
		}
		const block = await this.composeBlock(summary);
		try {
			const result = await s.compact(block, this.opts.config.keepLastTurns, submitted ? 1 : 0);
			this.rearmCtx = undefined;
			this.opts.onNote?.(
				`✦ compacted — dropped ${result.droppedItems} items, kept last ${result.keptTurns} turns`,
			);
			return { kind: "compacted", result };
		} catch (e) {
			// Covers BOTH a rejected compact (engine `error` event) and a hung
			// one (Session.compact's CompactTimeoutError, spec §3 "fails or
			// times out"): abort untouched, surface the warning, apply the
			// re-arm rule. run()'s finally clears inProgress either way.
			this.rearmCtx = this.armFloor();
			this.opts.onNote?.(`compaction failed: ${(e as Error).message}`);
			return { kind: "failed", reason: (e as Error).message };
		}
	}

	/** Failed-cycle re-arm rule: ctx must grow past failure-time + 2% of limit. */
	private armFloor(): number | undefined {
		if (this.lastCtx === undefined || !this.lastLimit) return this.lastCtx;
		return this.lastCtx + Math.round(this.lastLimit * 0.02);
	}

	private async composeBlock(summary: string): Promise<string> {
		const parts = ["[Context summary — session compacted]", "", summary.trim()];
		if (this.opts.config.rehydrate && this.opts.rehydrate) {
			try {
				const block = await this.opts.rehydrate();
				if (block) {
					parts.push(
						"",
						"[Carried-forward project memory]",
						"",
						block.slice(0, REHYDRATE_MAX_CHARS),
					);
				}
			} catch {
				/* rehydration is best-effort; never blocks compaction */
			}
		}
		return parts.join("\n");
	}
}
