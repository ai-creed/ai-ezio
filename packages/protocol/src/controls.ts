/**
 * Controls: harness → hax (fd 4). See docs/protocol.md.
 *
 * M3 implements `submit` and `interrupt`. The M4 controls
 * (`new_conversation`, `status`, `copy_last_response`) are typed here as
 * documented groundwork — they are NOT required to function in M3 (see the M3
 * spec); the engine does not act on them yet.
 */

export interface SubmitControl {
	type: "submit";
	text: string;
}

export interface InterruptControl {
	type: "interrupt";
}

/** One host-provided tool advertised to the model; its result comes via tool_result (M9). */
export interface DelegatedToolDef {
	name: string;
	description: string;
	parametersSchema: Record<string, unknown>;
}

/** Sent once after `ready`, before the first `submit` (M9). */
export interface RegisterDelegatedToolsControl {
	type: "register_delegated_tools";
	tools: DelegatedToolDef[];
}

/** The host's reply to a `tool_call_requested`, correlated by callId (M9). */
export interface ToolResultControl {
	type: "tool_result";
	callId: string;
	output: string;
	status: "ok" | "error";
}

/** M4 groundwork (typed only; no M3 engine behavior). */
export interface NewConversationControl {
	type: "new_conversation";
}

/** M4 groundwork (typed only; no M3 engine behavior). */
export interface StatusControl {
	type: "status";
}

/** M4 groundwork (typed only; no M3 engine behavior). */
export interface CopyLastResponseControl {
	type: "copy_last_response";
}

/** Controls implemented in M3. */
export type M3Control = SubmitControl | InterruptControl;

/** Full control surface (M3 + M4 groundwork types). */
export type ProtocolControl =
	| SubmitControl
	| InterruptControl
	| RegisterDelegatedToolsControl
	| ToolResultControl
	| NewConversationControl
	| StatusControl
	| CopyLastResponseControl;

export type ControlType = ProtocolControl["type"];
