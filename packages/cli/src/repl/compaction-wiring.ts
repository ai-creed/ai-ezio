/**
 * Compaction wiring for the standalone runtime (M11): builds the Compactor's
 * injected callbacks from the pieces the runtime already owns — the MCP host
 * (cortex rehydration) and the session recorder (deterministic digest) — and
 * wraps the cycle with "compacting…" chrome + renderer suppression.
 *
 * The host stays name-agnostic (hostToolNames is generic discovery); picking
 * the rehydration tool is ezio's opinion and lives HERE, in the wiring layer.
 */
import {
	Compactor,
	SUMMARIZE_INSTRUCTION,
	type CompactionConfig,
	type Session,
} from "@ai-ezio/harness";
import { callHostRehydration, type RehydrationHost } from "@ai-ezio/mcp-host";
import type { RecordedTurn } from "@ai-ezio/session-recorder";

// Re-exported so callers (and this module's tests) keep importing these from
// here; the implementation moved to @ai-ezio/mcp-host once the ai-whisper
// mounted adapter needed the same rehydration opinion (one shared helper).
export { callHostRehydration };
export type { RehydrationHost };

export interface DigestSource {
	recentTurns(): readonly RecordedTurn[];
}

/** Deterministic digest from the recorder's captured turns (spec §3 fallback:
 * survival beats summary quality when the summarizer is unavailable).
 * Summarize attempts are EXCLUDED: the failed summarize turn is finalized by
 * the recorder before this runs, and including it would re-import the very
 * exchange `dropLastTurns: 1` drops from history (spec §3 exclusion). */
export function digestFromRecorder(source: DigestSource): string | null {
	const turns = source.recentTurns().filter((t) => t.userText !== SUMMARIZE_INSTRUCTION);
	if (turns.length === 0) return null;
	const lines = turns.slice(-30).map((t) => {
		const tools = t.toolCalls.map((c) => c.name).join(",");
		const head = t.userText.slice(0, 120).replace(/\n/g, " ");
		return `- ${head}${tools ? ` [tools: ${tools}]` : ""}`;
	});
	return ["Deterministic digest (summarizer unavailable):", ...lines].join("\n");
}

export interface WiredCompactor {
	compactor: Compactor;
	/** True while a cycle runs — the runtime suppresses normal renderer output
	 * for the summarize turn and shows the compacting chrome instead. */
	compacting: () => boolean;
}

export function buildCompactor(opts: {
	session: Pick<Session, "runExclusive">;
	config: CompactionConfig;
	host?: RehydrationHost;
	digest?: DigestSource;
	write: (s: string) => void;
}): WiredCompactor {
	let active = false;
	const compactor = new Compactor({
		session: opts.session,
		config: opts.config,
		rehydrate:
			opts.config.rehydrate && opts.host ? () => callHostRehydration(opts.host!) : undefined,
		fallbackDigest: opts.digest
			? () => Promise.resolve(digestFromRecorder(opts.digest!))
			: undefined,
		onCycleStart: () => {
			active = true;
			opts.write("compacting…\r\n");
		},
		onNote: (line) => {
			active = false; // the outcome line ends the suppressed span
			opts.write(`${line}\r\n`);
		},
	});
	return { compactor, compacting: () => active };
}
