/**
 * Rehydration helper (M11) — shared across ezio surfaces. The generic host
 * stays name-agnostic (`hostToolNames()` is plain discovery), so picking WHICH
 * host tool rehydrates project memory is an ezio opinion. It lived in the CLI's
 * compaction wiring while there was a single consumer; it was promoted here once
 * the ai-whisper mounted adapter needed the same opinion (AGENTS.md: MCP policy
 * intelligence lives in mcp-host, layered on the host's generic discovery).
 */
import type { McpHost } from "./host.js";

/** The slice of McpHost rehydration needs (narrow for testability). */
export type RehydrationHost = Pick<McpHost, "hostToolNames" | "callHostTool">;

/** The rehydration-capable host tool, by namespaced-name convention. */
const REHYDRATE_TOOL_RE = /__(rehydrate_project|recall_memory)$/;

/** Best-effort project-memory block via the generic host. Resolves null on any
 * miss (no matching tool, error status, empty output, or a throw) — rehydration
 * must never block compaction. `callHostTool` returns { output, status } and the
 * host injects cwd-shaped args (worktreePath/path) itself. */
export async function callHostRehydration(host: RehydrationHost): Promise<string | null> {
	const name = host.hostToolNames().find((n) => REHYDRATE_TOOL_RE.test(n));
	if (!name) return null;
	try {
		const res = await host.callHostTool(name, {});
		return res.status === "ok" && res.output.trim() ? res.output : null;
	} catch {
		return null;
	}
}
