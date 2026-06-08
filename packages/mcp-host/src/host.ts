/** The MCP host: wires a Session's delegated tools to MCP servers. */
import type { DelegatedToolDef, ProtocolEvent } from "@ai-ezio/protocol";
import type { Session } from "@ai-ezio/harness";
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
	/** Repo-root arg names forced to cwd (default ["worktreePath","path"] — the
	 * ai-* convention). Drift-proof: overrides model-supplied values. */
	injectArgs?: string[];
	/** Per-call timeout; the host ALWAYS replies before hax's 120s backstop. Default 60s. */
	callTimeoutMs?: number;
	/** Injectable for tests; defaults to stdio connect. */
	connect?: (server: ServerConfig) => Promise<McpClient>;
	/** One-line warnings surfaced ONLY on failure (per spec). Defaults to stderr. */
	warn?: (msg: string) => void;
	/** Standalone-only confirm prompt; returns true to allow. */
	confirm?: (name: string) => Promise<boolean>;
}

export class McpHost {
	private readonly routes = new RouteMap();
	private readonly clients = new Map<string, McpClient>();
	/** Namespaced name → def (for schema-aware cwd injection). */
	private readonly defsByName = new Map<string, DelegatedToolDef>();
	private session?: HostSession;

	constructor(private readonly opts: McpHostOptions) {}

	/** Connect servers, list tools, register with the session. Failures are
	 * surfaced as one-line warnings; the host continues with whatever connected. */
	async start(session: HostSession): Promise<void> {
		this.session = session;
		const connect = this.opts.connect ?? connectStdio;
		const defs: DelegatedToolDef[] = [];
		for (const server of this.opts.servers) {
			try {
				const client = await connect(server);
				this.clients.set(server.name, client);
				for (const def of await client.listTools()) {
					const name = this.routes.add(server.name, def.name);
					const namespaced = { ...def, name };
					this.defsByName.set(name, namespaced);
					defs.push(namespaced);
				}
			} catch (e) {
				this.warn(`mcp: server "${server.name}" failed to connect: ${(e as Error).message}`);
			}
		}
		if (defs.length) session.registerDelegatedTools(defs);
	}

	/** Feed every protocol event here (wire as Session.onEvent). Acts only on
	 * tool_call_requested. */
	async handleEvent(event: ProtocolEvent): Promise<void> {
		if (event.type !== "tool_call_requested") return;
		const { callId, name, args } = event;
		const route = this.routes.resolve(name);
		if (!route) return this.reply(callId, `unknown tool: ${name}`, "error");

		const policy = decidePolicy(name, this.opts.toolPolicy, this.opts.mode);
		if (policy === "deny") return this.reply(callId, `tool "${name}" is blocked by policy`, "error");
		if (policy === "confirm") {
			const ok = this.opts.confirm ? await this.opts.confirm(name) : false;
			if (!ok) return this.reply(callId, `tool "${name}" was not confirmed`, "error");
		}

		const client = this.clients.get(route.server);
		if (!client) return this.reply(callId, `server "${route.server}" unavailable`, "error");
		try {
			const injected = this.injectCwd(name, args);
			const res = await withTimeout(
				client.callTool(route.tool, injected),
				this.opts.callTimeoutMs ?? 60_000,
				`call ${name}`,
			);
			this.reply(callId, res.output, res.status);
		} catch (e) {
			// Covers BOTH a per-call timeout AND a crashed/hung/down server: the host
			// ALWAYS replies, so hax never reaches its 120s backstop and never hangs.
			this.warn(`mcp: call ${name} failed: ${(e as Error).message}`);
			this.reply(callId, `tool call failed: ${(e as Error).message}`, "error");
		}
	}

	/** Force repo-root args (worktreePath/path) to the session cwd. Overrides any
	 * model-supplied value (drift-proof) AND fills when omitted — but ONLY for args
	 * the tool's own schema declares, so we never add a property the server would
	 * reject and never clobber an unrelated `path`. */
	private injectCwd(name: string, args: Record<string, unknown>): Record<string, unknown> {
		const schema = this.defsByName.get(name)?.parametersSchema as
			| { properties?: Record<string, unknown> }
			| undefined;
		const props = schema?.properties ?? {};
		const injectArgs = this.opts.injectArgs ?? ["worktreePath", "path"];
		const out = { ...args };
		for (const arg of injectArgs) if (arg in props) out[arg] = this.opts.cwd;
		return out;
	}

	private reply(callId: string, output: string, status: "ok" | "error"): void {
		this.session?.sendToolResult(callId, output, status);
	}

	private warn(msg: string): void {
		(this.opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(msg);
	}

	async stop(): Promise<void> {
		for (const c of this.clients.values()) await c.close().catch(() => {});
		this.clients.clear();
	}
}
