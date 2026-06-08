/** Per-tool permission decision: allow | deny | confirm. */
import type { ToolPolicy } from "./config.js";

export type RunMode = "standalone" | "mounted";

/** Conservative default deny-list (curate later per spec). */
export const DEFAULT_DENY: readonly string[] = [
	"cortex__purge_memory",
	"cortex__trash_memory",
	"cortex__promote_to_global",
];

/** Resolve the effective policy for a namespaced tool. Config wins; otherwise the
 * default deny-list applies, else allow. `confirm` only has teeth in standalone
 * (a human is present); in mounted it degrades to deny. */
export function decidePolicy(
	name: string,
	configPolicy: Record<string, ToolPolicy>,
	mode: RunMode,
): ToolPolicy {
	const base: ToolPolicy = configPolicy[name] ?? (DEFAULT_DENY.includes(name) ? "deny" : "allow");
	if (base === "confirm" && mode === "mounted") return "deny";
	return base;
}
