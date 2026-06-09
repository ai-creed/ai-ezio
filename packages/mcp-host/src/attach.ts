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
		confirm: opts.confirm,
		connect: opts.connect,
	});
}

/** Build an MCP host from `mcp.json` on disk (the both-modes entry point). The
 * caller MUST: (1) construct the Session with onEvent fanning to host.handleEvent,
 * (2) await session.start(), (3) `await host.start(session)` BEFORE the first
 * submit so the first turn sees the tools. */
export function loadMcpHost(opts: CreateHostOptions & { env?: NodeJS.ProcessEnv }): McpHost {
	return createMcpHost(loadConfig(opts.env ?? process.env), opts);
}
