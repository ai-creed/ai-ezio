/** The ONLY cortex-aware adapter. Writes the Claude-format projection and triggers
 * `capture_session` through the host-private `callHostTool` path (NEVER advertised to
 * the model). cortex specifics (schema, file, tool name) are quarantined here. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderCortexLines } from "./cortex-projection.js";
import type { ConversationRef, FlushReason, HostToolCaller, RecordedTurn, SessionSink } from "./types.js";

export interface CortexSessionSinkOptions {
	host: HostToolCaller;
	stateDir: string;
	repoKey: string;
	/** Namespaced tool name. Default "cortex__capture_session". */
	toolName?: string;
	/** Compute embeddings during capture. Default true. */
	embed?: boolean;
	/** One-line failure warnings. Defaults to stderr. */
	warn?: (msg: string) => void;
}

export class CortexSessionSink implements SessionSink {
	private readonly lineNo = new Map<string, number>();

	constructor(private readonly opts: CortexSessionSinkOptions) {}

	private path(ref: ConversationRef): string {
		return join(this.opts.stateDir, "sessions", this.opts.repoKey, `${ref.conversationId}.cortex.jsonl`);
	}

	onTurnComplete(turn: RecordedTurn): void {
		const p = this.path(turn.ref);
		mkdirSync(dirname(p), { recursive: true });
		const start = this.lineNo.get(turn.ref.conversationId) ?? 0;
		const lines = renderCortexLines(turn, start);
		appendFileSync(p, `${lines.join("\n")}\n`);
		this.lineNo.set(turn.ref.conversationId, start + lines.length);
	}

	async flush(ref: ConversationRef, _reason: FlushReason): Promise<void> {
		try {
			await this.opts.host.callHostTool(this.opts.toolName ?? "cortex__capture_session", {
				worktreePath: ref.worktreePath,
				sessionId: ref.conversationId,
				transcriptPath: this.path(ref),
				embed: this.opts.embed ?? true,
			});
		} catch (e) {
			this.warn(`cortex capture failed: ${(e as Error).message}`);
		}
	}

	private warn(msg: string): void {
		(this.opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(msg);
	}
}
