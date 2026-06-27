/** The subagent host: registers a `subagent` delegated tool and services its
 * calls by running a child hax session. Implements DelegatedToolProvider so it
 * slots into a DelegatedToolRegistry alongside the MCP host. */
import type { DelegatedReply, DelegatedToolProvider, Session } from "@ai-ezio/harness";
import type { DelegatedToolDef, ProtocolEvent, ToolCallRequestedEvent } from "@ai-ezio/protocol";
import type { Catalog } from "./catalog.js";
import {
	runSubagent,
	type ChildMcp,
	type ChildSession,
	type DispatchHandle,
	type SubagentUsage,
} from "./dispatch.js";

export type HostSession = Pick<Session, "registerDelegatedTools" | "sendToolResult">;

/** Build the advertised tool def from the catalog (enum = profile names). */
export function subagentToolDef(catalog: Catalog): DelegatedToolDef {
	const lines = catalog.names.map((n) => {
		const p = catalog.profiles[n];
		return `${n}${p?.label ? ` = ${p.label}` : ""}`;
	});
	return {
		name: "subagent",
		description:
			"Delegate a self-contained subtask to a smaller/cheaper model running as an autonomous " +
			"coding agent in this same repository. The subagent has no prior conversation context — give " +
			"it complete instructions. Returns the subagent's final answer. Prefer the smallest profile " +
			`that can do the job. Profiles: ${lines.join("; ")}.`,
		parametersSchema: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Full, self-contained instructions for the subagent.",
				},
				profile: { type: "string", enum: catalog.names },
			},
			required: ["task"],
		},
	};
}

/** Compact "4.2k tok" suffix from the child's output-token count, or "" when absent. */
function formatTokens(usage?: SubagentUsage): string {
	const n = usage?.outputTokens;
	if (typeof n !== "number" || n < 0) return "";
	const k = n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`;
	return `${k} tok`;
}

export interface SubagentHostOptions {
	catalog: Catalog;
	cwd: string;
	parentEnv: NodeJS.ProcessEnv;
	makeSession: (onEvent: (e: unknown) => void) => ChildSession;
	makeMcpHost: (cwd: string) => ChildMcp;
	/** Injectable dispatcher (tests); defaults to runSubagent. */
	dispatch?: typeof runSubagent;
	/** Optional one-line activity reporter (surface). Default: no-op. */
	report?: (line: string) => void;
}

export class SubagentHost implements DelegatedToolProvider {
	readonly id = "subagent";
	private inFlight: DispatchHandle | undefined;

	constructor(private readonly opts: SubagentHostOptions) {}

	/** No-op (the catalog is built at construction); idempotent across resume. */
	async init(): Promise<void> {}

	/** The `subagent` def when the catalog is non-empty, else nothing. */
	tools(): DelegatedToolDef[] {
		return this.opts.catalog.names.length ? [subagentToolDef(this.opts.catalog)] : [];
	}

	/** Cancel an in-flight child when the parent turn ends (idle/error) — no orphan. */
	observe(event: ProtocolEvent): void {
		if ((event.type === "idle" || event.type === "error") && this.inFlight) {
			this.inFlight.cancel();
			this.inFlight = undefined;
		}
	}

	/** Service a routed `subagent` call, replying via the injected reply. */
	async handleToolCall(event: ToolCallRequestedEvent, reply: DelegatedReply): Promise<void> {
		const { callId, args } = event;
		const task = typeof args.task === "string" ? args.task : "";
		if (!task.trim()) return reply(callId, "subagent: missing 'task'", "error");
		const name = typeof args.profile === "string" ? args.profile : this.opts.catalog.default;
		const profile = name ? this.opts.catalog.profiles[name] : undefined;
		if (!profile) {
			return reply(
				callId,
				`unknown profile "${String(args.profile)}"; valid: ${this.opts.catalog.names.join(", ")}`,
				"error",
			);
		}
		const dispatch = this.opts.dispatch ?? runSubagent;
		this.opts.report?.(`▸ subagent [${name}] …running`);
		const handle = dispatch({
			task,
			profile,
			cwd: this.opts.cwd,
			parentEnv: this.opts.parentEnv,
			timeoutMs: this.opts.catalog.timeoutMs,
			makeSession: this.opts.makeSession,
			makeMcpHost: this.opts.makeMcpHost,
		});
		this.inFlight = handle;
		try {
			const r = await handle.promise;
			// Clear BEFORE replying so the turn's settling idle does not trigger a
			// spurious cancel of an already-finished dispatch.
			this.inFlight = undefined;
			const secs = Math.round(r.elapsedMs / 100) / 10;
			const tok = formatTokens(r.usage);
			this.opts.report?.(`✔ subagent [${name}] ${secs}s${tok ? ` · ${tok}` : ""}`);
			reply(callId, r.output, r.status);
		} catch (e) {
			this.inFlight = undefined;
			reply(callId, `subagent failed: ${(e as Error).message}`, "error");
		}
	}

	async stop(): Promise<void> {
		this.inFlight?.cancel();
		this.inFlight = undefined;
	}
}
