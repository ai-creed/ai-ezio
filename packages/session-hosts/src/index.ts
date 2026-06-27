/**
 * @ai-ezio/session-hosts — the shared delegated-tool stack for a Session. Builds the
 * MCP host + the subagent host, wraps them in one DelegatedToolRegistry, and raises
 * the delegated-call timeout backstop. Consumed by every Session creator (the ezio
 * standalone CLI; the ai-whisper mounted adapter downstream).
 */
import { DelegatedToolRegistry } from "@ai-ezio/harness";
import { loadMcpHost, type McpHost, type RunMode } from "@ai-ezio/mcp-host";
import { loadSubagentHost } from "@ai-ezio/subagent";
import { ensureDelegatedTimeout } from "./timeout.js";

export { ensureDelegatedTimeout, SUBAGENT_DELEGATED_TIMEOUT_SECS } from "./timeout.js";

/** Build the standard delegated-tool stack. Returns the registry (wired by the
 * creator) plus the McpHost for its host-private API (recorder/compactor). */
export function loadSessionHosts(opts: {
	mode: RunMode;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	report?: (line: string) => void;
	notes?: string[];
}): { registry: DelegatedToolRegistry; mcpHost: McpHost } {
	ensureDelegatedTimeout(opts.env);
	const mcpHost = loadMcpHost({ mode: opts.mode, cwd: opts.cwd, env: opts.env });
	const subagentHost = loadSubagentHost({
		cwd: opts.cwd,
		env: opts.env,
		report: opts.report,
		notes: opts.notes,
	});
	const registry = new DelegatedToolRegistry([mcpHost, subagentHost]);
	return { registry, mcpHost };
}
