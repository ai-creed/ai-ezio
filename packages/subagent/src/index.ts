/**
 * @ai-ezio/subagent — the subagent host. Registers a `subagent` delegated tool
 * and services its calls by spawning a child hax session on a named profile.
 */
export {
	SubagentHost,
	subagentToolDef,
	type HostSession,
	type SubagentHostOptions,
} from "./host.js";
export { loadSubagentHost } from "./attach.js";
export { buildCatalog, type Catalog } from "./catalog.js";
export {
	probeCodexModels,
	seedCodexProfiles,
	parseCodexModels,
	type CodexModel,
} from "./codex-probe.js";
export {
	runSubagent,
	type ChildSession,
	type ChildMcp,
	type DispatchHandle,
	type SubagentUsage,
} from "./dispatch.js";
