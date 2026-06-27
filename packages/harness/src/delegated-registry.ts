/**
 * Delegated-tool host registry. Owns registration, name→owner routing, and the
 * lifecycle of every host-delegated-tool provider (the MCP host, the subagent host,
 * future hosts) so the Session creators wire ONE registry instead of each host.
 */
import type { DelegatedToolDef, ProtocolEvent, ToolCallRequestedEvent } from "@ai-ezio/protocol";
import type { Session } from "./session.js";

/** How a provider returns a delegated tool's result; injected by the registry so
 * providers never hold the Session themselves. */
export type DelegatedReply = (callId: string, output: string, status: "ok" | "error") => void;

/** A source of host-delegated tools. The registry owns registration/routing/lifecycle;
 * a provider supplies its defs and the per-call/lifecycle behavior. */
export interface DelegatedToolProvider {
	/** Stable id for diagnostics + duplicate-name messages (e.g. "mcp", "subagent"). */
	readonly id: string;
	/** Async setup before tools() is collected (e.g. MCP connect). MUST be idempotent —
	 * a resume re-call resets the provider's own prior state before re-acquiring. */
	init?(): void | Promise<void>;
	/** Advertised defs, collected once per start() after init(). */
	tools(): DelegatedToolDef[];
	/** Service a call the registry routed here (only this provider's own names). */
	handleToolCall(event: ToolCallRequestedEvent, reply: DelegatedReply): void | Promise<void>;
	/** Observe non-tool-call lifecycle events (idle/error/…). Optional. */
	observe?(event: ProtocolEvent): void;
	/** Teardown. Optional. */
	stop?(): void | Promise<void>;
}

/** Minimal Session surface the registry needs. */
export type RegistrySession = Pick<Session, "registerDelegatedTools" | "sendToolResult">;

export class DelegatedToolRegistry {
	private readonly owner = new Map<string, DelegatedToolProvider>();
	private session?: RegistrySession;

	constructor(
		private readonly providers: DelegatedToolProvider[],
		private readonly warn: (msg: string) => void = (m) => void process.stderr.write(`${m}\n`),
	) {}

	/** Init each provider (isolated), collect tools into ONE merged registration, and
	 * build the name→owner map. Safe to call again on resume (rebuilds from scratch). */
	async start(session: RegistrySession): Promise<void> {
		this.session = session;
		this.owner.clear();
		const defs: DelegatedToolDef[] = [];
		for (const p of this.providers) {
			try {
				await p.init?.();
			} catch (e) {
				this.warn(
					`delegated provider "${p.id}" init failed: ${(e as Error).message} — skipping its tools`,
				);
				continue;
			}
			for (const d of p.tools()) {
				if (this.owner.has(d.name)) {
					this.warn(
						`delegated tool "${d.name}" registered by "${p.id}" collides with "${this.owner.get(d.name)!.id}" — keeping the first`,
					);
					continue;
				}
				this.owner.set(d.name, p);
				defs.push(d);
			}
		}
		if (defs.length) session.registerDelegatedTools(defs);
	}

	/** Wire as one entry in the creator's onEvent tee. Routes a tool_call_requested to
	 * its owner; broadcasts everything else to observers. Non-blocking. */
	handleEvent(event: ProtocolEvent): void {
		if (event.type === "tool_call_requested") {
			const p = this.owner.get(event.name);
			if (!p) return; // not a tool we registered — hax never emits this; ignore
			const reply: DelegatedReply = (callId, output, status) =>
				this.session?.sendToolResult(callId, output, status);
			void p.handleToolCall(event, reply);
			return;
		}
		for (const p of this.providers) p.observe?.(event);
	}

	async stop(): Promise<void> {
		for (const p of this.providers) await p.stop?.();
	}
}
