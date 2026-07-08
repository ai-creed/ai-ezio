/** The MCP host: wires a Session's delegated tools to MCP servers. */
import type { DelegatedToolDef, ToolCallRequestedEvent } from "@ai-ezio/protocol";
import type { DelegatedReply, DelegatedToolProvider, Session } from "@ai-ezio/harness";
import type { ServerConfig, ToolPolicy } from "./config.js";
import { RouteMap } from "./namespace.js";
import { connectStdio, withTimeout, type McpClient } from "./mcp-client.js";
import { decidePolicy, type RunMode } from "./policy.js";

/** The minimal Session surface the host needs (keeps the host unit-testable). */
export type HostSession = Pick<Session, "registerDelegatedTools" | "sendToolResult">;

export interface McpHostOptions {
	mode: RunMode;
	cwd: string;
	servers: ServerConfig[];
	toolPolicy: Record<string, ToolPolicy>;
	/** Repo-root arg names forced to cwd (default DEFAULT_INJECT_ARGS — the ai-*
	 * convention). Drift-proof: overrides model-supplied values. A server's own
	 * `ServerConfig.injectArgs` wins over this; [] disables injection. NOTE the
	 * default deliberately includes "path": cortex rehydration (callHostTool with
	 * `{}`) relies on the host filling it. Generic servers whose `path` means
	 * something else must opt out per server. */
	injectArgs?: string[];
	/** Namespaced tool names that must NOT be advertised to the model (excluded from
	 * registerDelegatedTools) but remain callable by the harness via callHostTool.
	 * Generic: the host hardcodes no tool/server name; ezio config supplies the list. */
	hostPrivateTools?: string[];
	/** Per-call timeout; the host ALWAYS replies before hax's 120s backstop. Default 60s. */
	callTimeoutMs?: number;
	/** Injectable for tests; defaults to stdio connect. */
	connect?: (server: ServerConfig) => Promise<McpClient>;
	/** One-line warnings surfaced ONLY on failure (per spec). Defaults to stderr. */
	warn?: (msg: string) => void;
	/** Standalone-only confirm prompt; returns true to allow. */
	confirm?: (name: string) => Promise<boolean>;
}

/** The ai-* convention: repo-root argument names the host forces to cwd. */
export const DEFAULT_INJECT_ARGS = ["worktreePath", "path"];

export class McpHost implements DelegatedToolProvider {
	readonly id = "mcp";
	private routes = new RouteMap(); // reassignable for idempotent init()
	private readonly clients = new Map<string, McpClient>();
	private readonly serversByName: Map<string, ServerConfig>;
	/** Namespaced name → def (for schema-aware cwd injection). */
	private readonly defsByName = new Map<string, DelegatedToolDef>();
	private advertised: DelegatedToolDef[] = [];

	constructor(private readonly opts: McpHostOptions) {
		this.serversByName = new Map(opts.servers.map((s) => [s.name, s]));
	}

	/** Connect servers + list tools, building the route map and advertised defs.
	 * Idempotent: tears down any prior connection state before reconnecting, so a
	 * resume re-init leaks no clients and leaves no stale routes/tools. */
	async init(): Promise<void> {
		for (const c of this.clients.values()) await c.close().catch(() => {});
		this.clients.clear();
		this.routes = new RouteMap();
		this.defsByName.clear();
		this.advertised = [];
		const connect = this.opts.connect ?? connectStdio;
		for (const server of this.opts.servers) {
			try {
				const client = await connect(server);
				this.clients.set(server.name, client);
				for (const def of await client.listTools()) {
					const name = this.routes.add(server.name, def.name);
					const namespaced = { ...def, name };
					this.defsByName.set(name, namespaced);
					if (!(this.opts.hostPrivateTools ?? []).includes(name)) this.advertised.push(namespaced);
				}
			} catch (e) {
				this.warn(`mcp: server "${server.name}" failed to connect: ${(e as Error).message}`);
			}
		}
	}

	/** Advertised (non-host-private) defs from the most recent init(). */
	tools(): DelegatedToolDef[] {
		return this.advertised;
	}

	/** Service a routed call (the registry guarantees the tool is ours). */
	async handleToolCall(event: ToolCallRequestedEvent, reply: DelegatedReply): Promise<void> {
		const { callId, name, args } = event;
		const route = this.routes.resolve(name);
		if (!route) return reply(callId, `unknown tool: ${name}`, "error"); // defensive; registry routes only owned
		const policy = decidePolicy(name, this.opts.toolPolicy, this.opts.mode);
		if (policy === "deny") return reply(callId, `tool "${name}" is blocked by policy`, "error");
		if (policy === "confirm") {
			const ok = this.opts.confirm ? await this.opts.confirm(name) : false;
			if (!ok) return reply(callId, `tool "${name}" was not confirmed`, "error");
		}
		const client = this.clients.get(route.server);
		if (!client) return reply(callId, `server "${route.server}" unavailable`, "error");
		try {
			const injected = this.injectCwd(name, args);
			const res = await withTimeout(
				client.callTool(route.tool, injected),
				this.opts.callTimeoutMs ?? 60_000,
				`call ${name}`,
			);
			reply(callId, res.output, res.status);
		} catch (e) {
			this.warn(`mcp: call ${name} failed: ${(e as Error).message}`);
			reply(callId, `tool call failed: ${(e as Error).message}`, "error");
		}
	}

	/** Namespaced names of every connected tool (advertised + host-private).
	 * Generic discovery surface for harness wiring (M11 — e.g. picking a
	 * rehydration tool); the host itself hardcodes no tool or server name. */
	hostToolNames(): string[] {
		return [...this.defsByName.keys()];
	}

	/** Harness-private MCP call: invoke a tool directly, WITHOUT advertising it to the
	 * model or riding the tool_call_requested path. For tools listed in
	 * `hostPrivateTools` (e.g. cortex__capture_session). Policy `deny` still blocks;
	 * the standalone `confirm` prompt is skipped (host-initiated calls are trusted). */
	async callHostTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ output: string; status: "ok" | "error" }> {
		const route = this.routes.resolve(name);
		if (!route) throw new Error(`unknown host tool: ${name}`);
		if (decidePolicy(name, this.opts.toolPolicy, this.opts.mode) === "deny")
			throw new Error(`host tool "${name}" is blocked by policy`);
		const client = this.clients.get(route.server);
		if (!client) throw new Error(`server "${route.server}" unavailable`);
		const injected = this.injectCwd(name, args);
		return withTimeout(
			client.callTool(route.tool, injected),
			this.opts.callTimeoutMs ?? 60_000,
			`host call ${name}`,
		);
	}

	/** Force repo-root args (worktreePath/path by default) to the session cwd.
	 * Overrides any model-supplied value (drift-proof) AND fills when omitted —
	 * but ONLY for args the tool's own schema declares, so we never add a
	 * property the server would reject. The list resolves per server:
	 * `ServerConfig.injectArgs` ?? the host-level option ?? the ai-* default
	 * ([] at either level disables injection). */
	private injectCwd(name: string, args: Record<string, unknown>): Record<string, unknown> {
		const schema = this.defsByName.get(name)?.parametersSchema as
			| { properties?: Record<string, unknown> }
			| undefined;
		const props = schema?.properties ?? {};
		const server = this.routes.resolve(name)?.server;
		const injectArgs =
			(server !== undefined ? this.serversByName.get(server)?.injectArgs : undefined) ??
			this.opts.injectArgs ??
			DEFAULT_INJECT_ARGS;
		const out = { ...args };
		for (const arg of injectArgs) if (arg in props) out[arg] = this.opts.cwd;
		return out;
	}

	private warn(msg: string): void {
		(this.opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(msg);
	}

	async stop(): Promise<void> {
		for (const c of this.clients.values()) await c.close().catch(() => {});
		this.clients.clear();
	}
}
