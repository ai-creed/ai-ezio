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
}

export interface ToolCallFinishedEvent {
	type: "tool_call_finished";
	turnId: string;
	name: string;
	callId: string;
	status: "ok" | "error";
}

export interface AssistantTurnFinishedEvent {
	type: "assistant_turn_finished";
	turnId: string;
	/** Authoritative handback: the final assistant message of the user turn. */
	content: string;
}

export interface IdleEvent {
	type: "idle";
}

export interface ErrorEvent {
	type: "error";
	message: string;
	turnId?: string;
}

export type ProtocolEvent =
	| ReadyEvent
	| UserTurnStartedEvent
	| AssistantTurnStartedEvent
	| AssistantDeltaEvent
	| ToolCallStartedEvent
	| ToolCallFinishedEvent
	| AssistantTurnFinishedEvent
	| IdleEvent
	| ErrorEvent;

export type EventType = ProtocolEvent["type"];
