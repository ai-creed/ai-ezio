/** Neutral, host-agnostic session model + the generic seams the recorder fans out to. */

/** Per-turn token usage (ezio telemetry — kept in the durable record, NOT in the
 * cortex projection). Mirrors the protocol's assistant_turn_finished.usage. */
export interface TokenUsage {
	contextTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	contextLimit?: number;
}

/** Identifies one conversation. `conversationId` is the cortex sessionId (unique per
 * /new), sanitized to cortex's `^[\w-]+$`. */
export interface ConversationRef {
	sessionId: string;
	conversationId: string;
	worktreePath: string;
}

export interface RecordedToolCall {
	name: string;
	/** One-line summary string for native hax tools (tool_call_started.args); the full
	 * args object for delegated/MCP tools (tool_call_requested.args); undefined if neither. */
	input: string | Record<string, unknown> | undefined;
	status: "ok" | "error" | "pending";
	output?: string;
	isDiff?: boolean;
}

export interface RecordedTurn {
	ref: ConversationRef;
	index: number;
	/** ISO-8601 (ms) instant the turn finalized — end of generation. The telemetry
	 * time-bucket source; assigned in SessionRecorder.finalizeTurn. */
	timestamp: string;
	userText: string;
	assistantText: string;
	toolCalls: RecordedToolCall[];
	usage?: TokenUsage;
	/** Engine-reported model id (the latest status.model), verbatim. Omitted when
	 * no status has been observed for the session. */
	model?: string;
}

export type FlushReason = "debounce" | "everyK" | "new" | "close" | "compact";

/** The generic session-sink seam. The recorder appends completed turns (`onTurnComplete`)
 * and asks the sink to trigger capture (`flush`) per the recorder's policy. Knows nothing
 * about cortex. */
export interface SessionSink {
	onTurnComplete(turn: RecordedTurn): void | Promise<void>;
	flush(ref: ConversationRef, reason: FlushReason): void | Promise<void>;
}

/** ezio's durable per-turn record (source of truth; carries usage). */
export interface DurableStore {
	append(turn: RecordedTurn): void | Promise<void>;
}

/** Minimal surface the cortex sink needs from the MCP host — a host-private tool call
 * (NOT advertised to the model). Implemented by mcp-host's `McpHost.callHostTool`. */
export interface HostToolCaller {
	callHostTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ output: string; status: "ok" | "error" }>;
}
