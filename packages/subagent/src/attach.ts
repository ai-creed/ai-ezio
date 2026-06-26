/** Shared factory: build a SubagentHost from on-disk config + the live codex seed.
 * Used by every Session creator (standalone CLI now; mounted adapter later). */
import { loadConfig, Session } from "@ai-ezio/harness";
import { loadMcpHost } from "@ai-ezio/mcp-host";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { buildCatalog } from "./catalog.js";
import { probeCodexModels, seedCodexProfiles } from "./codex-probe.js";
import { SubagentHost } from "./host.js";
import type { ChildMcp, ChildSession } from "./dispatch.js";

/** Adapt a real harness Session to the ChildSession the dispatch runner needs,
 * forwarding the delegated-tool methods the child's MCP host calls. */
export function makeChildSession(s: Session): ChildSession {
	return {
		start: (o) => s.start(o),
		// s.submitAndWait returns { turnId, content, usage } after Task 2 — the usage
		// (AssistantTurnFinishedEvent["usage"]) is shape-compatible with SubagentUsage,
		// so the child's real token usage reaches the surface summary.
		submitAndWait: (text) => s.submitAndWait(text),
		close: () => s.close(),
		registerDelegatedTools: (tools) => s.registerDelegatedTools(tools),
		sendToolResult: (callId, output, status) => s.sendToolResult(callId, output, status),
	};
}

export function loadSubagentHost(opts: {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable codex runner (tests). */
	probeRun?: () => string | null;
	report?: (line: string) => void;
	/** Doctor-visible notes sink: a codex-probe failure note is pushed here. */
	notes?: string[];
}): SubagentHost {
	const env = opts.env ?? process.env;
	const { subagents } = loadConfig(env);
	const probe = probeCodexModels({ run: opts.probeRun, env });
	if (probe.note) opts.notes?.push(probe.note); // surfaces under `ai-ezio doctor`
	const seed = seedCodexProfiles(probe.models);
	const catalog = buildCatalog({ config: subagents, seed });

	// Real child factories: a fresh headless Session and a fresh MCP host, both
	// in the parent cwd. The child gets the full mcp.json ecosystem (mounted mode:
	// confirm -> deny, since no human is present at the child). The child is NOT
	// given a SubagentHost — recursion guard (no nested subagents in v0).
	const makeSession = (onEvent: (e: ProtocolEvent) => void): ChildSession => {
		const s = new Session({ onEvent });
		return makeChildSession(s);
	};
	const makeMcpHost = (cwd: string): ChildMcp => {
		const h = loadMcpHost({ mode: "mounted", cwd, env });
		return {
			start: (session) => h.start(session as Parameters<typeof h.start>[0]),
			stop: () => h.stop(),
			// expose handleEvent so dispatch can forward the child's events to it
			handleEvent: (e) => void h.handleEvent(e as Parameters<typeof h.handleEvent>[0]),
		} as ChildMcp & { handleEvent: (e: unknown) => void };
	};

	return new SubagentHost({
		catalog,
		cwd: opts.cwd,
		parentEnv: env,
		makeSession,
		makeMcpHost,
		report: opts.report,
	});
}
