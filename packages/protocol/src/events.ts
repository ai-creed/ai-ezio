/**
 * Events: hax → harness (fd 3). See docs/protocol.md. M3a emits a subset
 * (ready, user_turn_started, assistant_turn_started, assistant_delta,
 * assistant_turn_finished, idle); tool events + error land in M3b but are typed
 * here so consumers compile against the full M3 surface.
 */

export interface ReadyEvent {
	type: "ready";
	sessionId: string;
	protocol: string;
	haxBaseCommit: string;
}

export interface UserTurnStartedEvent {
	type: "user_turn_started";
	turnId: string;
	/** Echo of the accepted submit text (optional). */
	text?: string;
}

export interface AssistantTurnStartedEvent {
	type: "assistant_turn_started";
	turnId: string;
}

export interface AssistantDeltaEvent {
	type: "assistant_delta";
	turnId: string;
	text: string;
}

export interface ToolCallStartedEvent {
	type: "tool_call_started";
	turnId: string;
	name: string;
	callId: string;
	/** One-line summary of the call's arguments (M8); absent when not surfaced. */
	args?: string;
}

export interface ToolCallFinishedEvent {
	type: "tool_call_finished";
	turnId: string;
	name: string;
	callId: string;
	/** Execution outcome (M8: dispatch-sourced — `ok` ran, `error` refused/skipped). */
	status: "ok" | "error";
	/** Tool result text (M8); absent when the engine didn't surface it. */
	output?: string;
	/** True when `output` is a unified diff (render colored) (M8). */
	isDiff?: boolean;
}

export interface ToolCallRequestedEvent {
	type: "tool_call_requested";
	turnId: string;
	name: string;
	callId: string;
	/** Full model-supplied arguments object for the delegated tool (M9). */
	args: Record<string, unknown>;
}

export interface AssistantTurnFinishedEvent {
	type: "assistant_turn_finished";
	turnId: string;
	/** Authoritative handback: the final assistant message of the user turn. */
	content: string;
	/** Optional per-turn token usage (M7). Individual fields are omitted when the
	 * backend did not report them (hax `-1`); the object is absent entirely when
	 * no field is available (never `usage: null`/`undefined` on the wire). */
	usage?: {
		contextTokens?: number;
		outputTokens?: number;
		cachedTokens?: number;
		contextLimit?: number;
	};
}

export interface IdleEvent {
	type: "idle";
}

export interface ErrorEvent {
	type: "error";
	message: string;
	turnId?: string;
}

/** Reply to a `status` control (M4). `state` is `"idle"` in M4 (status is
 * answered between turns); `contextPercent` is null until reliably known. */
export interface StatusEvent {
	type: "status";
	model: string;
	provider: string;
	protocol: string;
	sessionId: string;
	state: "idle" | "busy";
	contextPercent?: number | null;
	/** Reasoning effort for this session (M7); empty/omitted when not set. In
	 * `--mount-mode` a `status` is auto-emitted once right after `ready`. */
	effort?: string;
}

export type ProtocolEvent =
	| ReadyEvent
	| UserTurnStartedEvent
	| AssistantTurnStartedEvent
	| AssistantDeltaEvent
	| ToolCallStartedEvent
	| ToolCallFinishedEvent
	| ToolCallRequestedEvent
	| AssistantTurnFinishedEvent
	| IdleEvent
	| ErrorEvent
	| StatusEvent;

export type EventType = ProtocolEvent["type"];
