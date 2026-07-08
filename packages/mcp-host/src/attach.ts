/** Shared factory used by BOTH Session creators (standalone CLI + mounted
 * adapter) so MCP behaves identically in both run modes. */
import { McpHost } from "./host.js";
import { loadConfig, type HostConfig, type ServerConfig } from "./config.js";
import type { McpClient } from "./mcp-client.js";
import { DEFAULT_HOST_PRIVATE, type RunMode } from "./policy.js";

export interface CreateHostOptions {
	mode: RunMode;
	cwd?: string;
	/** Standalone-only confirm prompt. */
	confirm?: (name: string) => Promise<boolean>;
	/** Injectable connect (tests). */
	connect?: (server: ServerConfig) => Promise<McpClient>;
}

/** Build an MCP host from an explicit config (pure — no disk). */
export function createMcpHost(cfg: HostConfig, opts: CreateHostOptions): McpHost {
	return new McpHost({
		mode: opts.mode,
		cwd: opts.cwd ?? process.cwd(),
		servers: cfg.servers,
		toolPolicy: cfg.toolPolicy,
		hostPrivateTools: [...new Set([...DEFAULT_HOST_PRIVATE, ...cfg.hostPrivateTools])],
		injectArgs: cfg.injectArgs,
		confirm: opts.confirm,
		connect: opts.connect,
	});
}

/** Build an MCP host from `mcp.json` on disk (the both-modes entry point). The
 * returned `McpHost` is a `DelegatedToolProvider` — register it with a
 * `DelegatedToolRegistry` (see `@ai-ezio/session-hosts`'s `loadSessionHosts`,
 * which bundles it with the subagent host), not by calling its methods directly.
 * The registry calls `init()` + `tools()` and routes `tool_call_requested` to
 * `handleToolCall`; `callHostTool`/`hostToolNames` remain for host-private use. */
export function loadMcpHost(opts: CreateHostOptions & { env?: NodeJS.ProcessEnv }): McpHost {
	return createMcpHost(loadConfig(opts.env ?? process.env), opts);
}
