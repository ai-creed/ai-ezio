/** Pure mcp.json reconciliation. Classify the cortex entry so the orchestrator
 * can OFFER repair/migration (never silently rewrites a working entry), and
 * collision-safe backup naming for malformed files (spec §5.4, finding 4).
 * Operates on the RAW object so unknown keys round-trip intact. */
export interface McpServerEntry {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}
export interface McpFile {
	mcpServers?: Record<string, McpServerEntry>;
	[key: string]: unknown;
}
export interface CortexEntry {
	command: string;
	args: string[];
}
export type CortexKind = "missing" | "valid-portable" | "valid-hardcoded" | "broken";

export function parseMcp(raw: string | null): { ok: true; obj: McpFile } | { ok: false } {
	if (raw === null || raw.trim() === "") return { ok: true, obj: {} };
	try {
		const o = JSON.parse(raw) as McpFile;
		return typeof o === "object" && o !== null ? { ok: true, obj: o } : { ok: false };
	} catch {
		return { ok: false };
	}
}

/** Does the existing cortex entry launch? For `ai-cortex mcp`, the command must
 * be on PATH; for `node <script> mcp`, the SCRIPT (args[0]) must exist. */
export function classifyCortex(
	obj: McpFile,
	deps: { entryWorks: (e: McpServerEntry) => boolean },
): CortexKind {
	const e = obj.mcpServers?.cortex;
	if (!e) return "missing";
	if (!deps.entryWorks(e)) return "broken";
	return e.command === "ai-cortex" ? "valid-portable" : "valid-hardcoded";
}

export function applyCortex(obj: McpFile, cortex: CortexEntry): McpFile {
	const servers = { ...(obj.mcpServers ?? {}) };
	servers.cortex = { command: cortex.command, args: [...cortex.args] };
	return { ...obj, mcpServers: servers };
}

/** The cortex entry to write: portable `ai-cortex mcp` when on PATH, else a
 * resolved-node fallback `node <cli.js> mcp` (spec §5.4 — handles global-list-only
 * installs not on PATH). Returns null when NEITHER is resolvable, so the caller
 * skips wiring + guides rather than writing an unusable `ai-cortex` command. */
export function cortexEntry(onPath: boolean, nodeCliPath: string | null): CortexEntry | null {
	if (onPath) return { command: "ai-cortex", args: ["mcp"] };
	if (nodeCliPath) return { command: "node", args: [nodeCliPath, "mcp"] };
	return null;
}

/** Does an existing cortex entry launch? Three command shapes — a valid entry must
 * never be misclassified as broken (spec §5.4):
 *   - a path command (contains "/", e.g. /usr/local/bin/ai-cortex) -> that file exists
 *   - `node <script> …` -> the script (args[0]) exists
 *   - a bare command (e.g. ai-cortex) -> resolvable on PATH */
export function cortexEntryLaunches(
	e: McpServerEntry,
	deps: { onPath: (cmd: string) => boolean; fileExists: (p: string) => boolean },
): boolean {
	if (e.command.includes("/")) return deps.fileExists(e.command);
	if (e.command === "node") return deps.fileExists(e.args?.[0] ?? "");
	return deps.onPath(e.command);
}

export function serializeMcp(obj: McpFile): string {
	return `${JSON.stringify(obj, null, "\t")}\n`;
}

/** First free backup name: mcp.json.bak, .bak.1, .bak.2, … never overwriting. */
export function nextBackupPath(configPath: string, exists: (p: string) => boolean): string {
	const base = `${configPath}.bak`;
	if (!exists(base)) return base;
	for (let n = 1; ; n++) {
		const c = `${base}.${n}`;
		if (!exists(c)) return c;
	}
}
