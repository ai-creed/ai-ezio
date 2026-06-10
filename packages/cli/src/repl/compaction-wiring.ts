/**
 * Compaction wiring for the standalone runtime (M11): builds the Compactor's
 * injected callbacks from the pieces the runtime already owns — the MCP host
 * (cortex rehydration) and the session recorder (deterministic digest) — and
 * wraps the cycle with "compacting…" chrome + renderer suppression.
 *
 * The host stays name-agnostic (hostToolNames is generic discovery); picking
 * the rehydration tool is ezio's opinion and lives HERE, in the wiring layer.
 */
import { Compactor, type CompactionConfig, type Session } from "@ai-ezio/harness";
import type { McpHost } from "@ai-ezio/mcp-host";
import type { RecordedTurn } from "@ai-ezio/session-recorder";

/** The rehydration-capable host tool, by namespaced-name convention. */
const REHYDRATE_TOOL_RE = /__(rehydrate_project|recall_memory)$/;

/** The slices the helpers need (narrow for testability). */
export type RehydrationHost = Pick<McpHost, "hostToolNames" | "callHostTool">;
export interface DigestSource {
	recentTurns(): readonly RecordedTurn[];
}

/** Best-effort cortex block via the generic MCP host. Resolves null on any
 * miss (no matching tool, error status, empty output) — rehydration never
 * blocks compaction. callHostTool returns { output, status } and the host
 * injects cwd-shaped args (worktreePath/path) itself. */
export async function callHostRehydration(host: RehydrationHost): Promise<string | null> {
	const name = host.hostToolNames().find((n) => REHYDRATE_TOOL_RE.test(n));
	if (!name) return null;
	try {
		const res = await host.callHostTool(name, {});
		return res.status === "ok" && res.output.trim() ? res.output : null;
	} catch {
		return null;
	}
}

/** Deterministic digest from the recorder's captured turns (spec §3 fallback:
 * survival beats summary quality when the summarizer is unavailable). */
export function digestFromRecorder(source: DigestSource): string | null {
	const turns = source.recentTurns();
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
