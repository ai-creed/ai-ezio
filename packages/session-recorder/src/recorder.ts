/** Assembles turns from the protocol event stream and drives the durable store + sink.
 * Wire `handleEvent` to `Session.onEvent`, and call `noteSubmit(text)` wherever the host
 * sends a `submit` so the next turn's user text is the authoritative submit text (spec §2;
 * the optional `user_turn_started.text` echo is only a fallback). Boundaries that have no
 * event (/new, shutdown) are signalled via `noteNewConversation()` / `close()`. */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import type {
	ConversationRef,
	DurableStore,
	FlushReason,
	RecordedToolCall,
	RecordedTurn,
	SessionSink,
} from "./types.js";

export interface RecorderOptions {
	worktreePath: string;
	store: DurableStore;
	sink: SessionSink;
	/** Quiet period after a turn before a debounced capture fires. Default 10_000ms. */
	idleDebounceMs?: number;
	/** Force a capture every K turns even if the debounce never fires. Default 10. */
	everyKTurns?: number;
}

/** Sanitize to cortex's `^[\w-]+$` (anything else → "-"). */
export function sanitizeId(s: string): string {
	return s.replace(/[^\w-]/g, "-");
}

export class SessionRecorder {
	private readonly idleDebounceMs: number;
	private readonly everyKTurns: number;

	private sessionId = "";
	private convCounter = 0;
	private conversationId = "";
	private turnIndex = 0;
	private turnsSinceFlush = 0;

	private current?: RecordedTurn;
	private readonly callsById = new Map<string, RecordedToolCall>();
	private readonly pendingSubmits: string[] = [];
	/** True once the current conversation has a completed turn not yet flushed. Gates
	 * flushes so an empty boundary (e.g. /new before any turn) is a no-op (spec §5). */
	private hasUncaptured = false;
	private debounce?: ReturnType<typeof setTimeout>;

	constructor(private readonly opts: RecorderOptions) {
		this.idleDebounceMs = opts.idleDebounceMs ?? 10_000;
		this.everyKTurns = opts.everyKTurns ?? 10;
	}

	private ref(): ConversationRef {
		return {
			sessionId: this.sessionId,
			conversationId: this.conversationId,
			worktreePath: this.opts.worktreePath,
		};
	}

	handleEvent(event: ProtocolEvent): void {
		switch (event.type) {
			case "ready":
				this.sessionId = event.sessionId;
				this.conversationId = sanitizeId(`${event.sessionId}-${this.convCounter}`);
				break;
			case "user_turn_started":
				this.current = {
					ref: this.ref(),
					index: this.turnIndex++,
					userText: this.pendingSubmits.shift() ?? event.text ?? "",
					assistantText: "",
					toolCalls: [],
				};
				this.callsById.clear();
				break;
			case "tool_call_started": {
				if (!this.current) break;
				const tc: RecordedToolCall = { name: event.name, input: event.args, status: "pending" };
				this.callsById.set(event.callId, tc);
				this.current.toolCalls.push(tc);
				break;
			}
			case "tool_call_requested": {
				if (!this.current) break;
				const existing = this.callsById.get(event.callId);
				if (existing) {
					existing.input = event.args;
				} else {
					const tc: RecordedToolCall = { name: event.name, input: event.args, status: "pending" };
					this.callsById.set(event.callId, tc);
					this.current.toolCalls.push(tc);
				}
				break;
			}
			case "tool_call_finished": {
				const tc = this.callsById.get(event.callId);
				if (tc) {
					tc.status = event.status;
					tc.output = event.output;
					tc.isDiff = event.isDiff;
				}
				break;
			}
			case "assistant_turn_finished":
				if (this.current) {
					this.current.assistantText = event.content;
					this.current.usage = event.usage;
				}
				break;
			case "idle":
				this.finalizeTurn();
				break;
			case "compacted":
				// Compaction is a continuation, not a boundary (M11 spec §6):
				// flush what is already captured (the lossless record keeps what
				// the model's context just lost), keep conversationId and turn
				// indexing as-is.
				this.triggerFlush("compact");
				break;
			default:
				break;
		}
	}

	/** Record the text of a `submit` control the host just sent, so the next
	 * `user_turn_started` is attributed to it (authoritative source per spec §2). FIFO:
	 * supports queued submits; the protocol echo `user_turn_started.text` is the fallback. */
	noteSubmit(text: string): void {
		this.pendingSubmits.push(text);
	}

	/** Boundary with no protocol event: the host is about to send `new_conversation`. */
	noteNewConversation(): void {
		this.triggerFlush("new");
		this.convCounter++;
		this.conversationId = sanitizeId(`${this.sessionId}-${this.convCounter}`);
		this.turnIndex = 0;
	}

	/** Session shutdown / fd-3 EOF. Awaitable so the caller can ensure the final
	 * capture completes before tearing down the MCP host / exiting the process. */
	async close(): Promise<void> {
		await this.doFlush("close");
	}

	private finalizeTurn(): void {
		const turn = this.current;
		if (!turn) return;
		this.current = undefined;
		void Promise.resolve(this.opts.store.append(turn));
		void Promise.resolve(this.opts.sink.onTurnComplete(turn));
		this.hasUncaptured = true;
		this.turnsSinceFlush++;
		if (this.turnsSinceFlush >= this.everyKTurns) {
			this.triggerFlush("everyK");
		} else {
			this.armDebounce();
		}
	}

	private armDebounce(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => this.triggerFlush("debounce"), this.idleDebounceMs);
	}

	/** Fire-and-forget flush (debounce / every-K / new) — never blocks the turn loop. */
	private triggerFlush(reason: FlushReason): void {
		void this.doFlush(reason);
	}

	/** Capture the current conversation IF it has an uncaptured turn; otherwise a no-op
	 * (so /new before any turn does not flush — spec §5). Always clears the debounce
	 * timer. Returns the sink's flush promise so close() can await the final capture. */
	private doFlush(reason: FlushReason): void | Promise<void> {
		if (this.debounce) {
			clearTimeout(this.debounce);
			this.debounce = undefined;
		}
		this.turnsSinceFlush = 0;
		if (!this.conversationId || !this.hasUncaptured) return; // nothing to capture
		this.hasUncaptured = false;
		return Promise.resolve(this.opts.sink.flush(this.ref(), reason));
	}
}
