/**
 * Event-driven auto-compaction driver (shared seam). Wraps the policy-owning
 * {@link Compactor} so any protocol-event consumer — the standalone CLI runtime
 * and the ai-whisper mounted adapter alike — can wire auto-compaction the SAME
 * way: pipe every {@link ProtocolEvent} through `handleEvent`, and gate your own
 * output/relay on `compacting()` so the injected summarize turn never leaks.
 *
 * The mapping is the whole point: `assistant_turn_finished.usage` feeds the
 * arming signal; `idle` is the only safe trigger point (a turn just settled), so
 * that is where an armed cycle fires. All compaction intelligence stays in the
 * Compactor; this is purely the event→policy adapter plus the in-flight flag.
 */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { Compactor, type CompactOutcome, type CompactorSession } from "./compactor.js";
import type { CompactionConfig } from "./config.js";

export interface AutoCompactDriverOptions {
	session: CompactorSession;
	config: CompactionConfig;
	/** Cortex rehydration block, injected by the wiring layer (best-effort). */
	rehydrate?: () => Promise<string | null>;
	/** Deterministic digest fallback when the summarizer is unavailable. */
	fallbackDigest?: () => Promise<string | null>;
	/** Surface a user-visible warning/outcome line. */
	onNote?: (line: string) => void;
	/** Fired when a cycle actually begins — consumers switch to compacting chrome. */
	onCycleStart?: () => void;
}

export interface AutoCompactDriver {
	/** Pipe every protocol event here: finished turns feed usage; `idle` fires an
	 * armed auto-compact cycle (fire-and-forget — the Compactor serializes). */
	handleEvent(event: ProtocolEvent): void;
	/** True while a summarize/compact cycle runs — suppress your own relay/output
	 * so the injected summarize turn is never delivered or rendered as a reply. */
	compacting(): boolean;
	/** Manual `/compact`: runs regardless of the threshold. */
	compactNow(): Promise<CompactOutcome>;
	/** Resolves once the most recent `idle`-triggered cycle has settled (for
	 * graceful shutdown and deterministic tests). */
	whenSettled(): Promise<void>;
}

export function createAutoCompactDriver(opts: AutoCompactDriverOptions): AutoCompactDriver {
	let active = false;
	let pending: Promise<unknown> = Promise.resolve();
	const compactor = new Compactor({
		session: opts.session,
		config: opts.config,
		rehydrate: opts.rehydrate,
		fallbackDigest: opts.fallbackDigest,
		onCycleStart: () => {
			active = true;
			opts.onCycleStart?.();
		},
		onNote: (line) => {
			active = false; // the outcome line ends the suppressed span
			opts.onNote?.(line);
		},
	});

	return {
		handleEvent(event: ProtocolEvent): void {
			switch (event.type) {
				case "assistant_turn_finished":
					compactor.noteUsage(event.usage);
					break;
				case "idle":
					// Fire-and-forget: a cycle stacked while one runs is a no-op
					// (Compactor's in-progress gate). `.catch` keeps a rare gate-level
					// rejection from surfacing as an unhandled rejection; the Compactor
					// already reports recoverable failures through onNote.
					pending = compactor.maybeAutoCompact().catch(() => undefined);
					break;
				default:
					break;
			}
		},
		compacting: () => active,
		compactNow: () => compactor.compactNow(),
		whenSettled: async () => {
			await pending;
		},
	};
}
