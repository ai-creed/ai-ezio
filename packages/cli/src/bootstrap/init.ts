/** Bootstrap orchestrator. Wiring is gated on opt-in AND availability; the
 * version gate is consumed (guidance, no upgrade); the profile write has its own
 * consent; opt-out/declined/failed paths wire nothing; prereq/hook guidance is
 * printed. Non-TTY without --yes never prompts (never hangs). */
import type { BridgeResult } from "./bridge.js";
import type { Environment } from "./detect.js";
import type { CortexKind } from "./reconcile-mcp.js";
import type { CompatResult, PeerName } from "./versions.js";

export interface InitOptions {
	yes: boolean;
	cortex: boolean;
	whisper: boolean;
	reconfigure: boolean;
}
export interface InitDeps {
	detect: () => Environment;
	checkCompat: (peer: PeerName, installed: string | null) => CompatResult;
	askYesNo: (question: string, defaultYes: boolean) => Promise<boolean>;
	installPeer: (manager: "npm" | "pnpm", pkg: string) => { ok: boolean; error?: string };
	classifyCortex: () => CortexKind;
	applyCortex: () => boolean; // writes the resolved cortex entry; false if it SKIPPED (unresolvable)
	persistBridge: (consent: boolean) => BridgeResult;
	whisperPrereqGuidance: () => string[];
	cortexHookGuidance: () => string[];
	writeMarker: () => void;
	out: (line: string) => void;
}

const PKG: Record<PeerName, string> = { cortex: "ai-cortex", whisper: "ai-whisper" };

export function parseInitArgs(argv: readonly string[]): InitOptions {
	return {
		yes: argv.includes("--yes"),
		cortex: !argv.includes("--no-cortex"),
		whisper: !argv.includes("--no-whisper"),
		reconfigure: argv.includes("--reconfigure"),
	};
}

/** Targeted remediation for a failed peer install (spec §6) — maps common error
 * classes to an actionable next step, always ending with a concrete retry line. */
export function remediationFor(pkg: string, error: string): string[] {
	const e = error.toLowerCase();
	const lines: string[] = [];
	if (e.includes("eacces") || e.includes("permission")) {
		lines.push(
			"  → EACCES: your global prefix isn't writable — use a Node version manager (nvm/volta/fnm) or fix the prefix.",
		);
	} else if (
		e.includes("etimedout") ||
		e.includes("enotfound") ||
		e.includes("network") ||
		e.includes("registry")
	) {
		lines.push("  → network error: check connectivity/proxy/registry, then retry.");
	} else if (
		e.includes("gyp") ||
		e.includes("prebuild") ||
		e.includes("make") ||
		e.includes("c++")
	) {
		lines.push(
			"  → native build failed: install platform build tools (Xcode CLT / build-essential), then retry.",
		);
	}
	lines.push(`  → retry: \`npm i -g ${pkg}\`, then \`ai-ezio init\`.`);
	return lines;
}

export async function runInit(opts: InitOptions, deps: InitDeps): Promise<number> {
	const env = deps.detect();
	const interactive = env.isTTY && !env.isCI && !opts.yes;

	// 1) Per-peer availability (present, or successfully installed). Never upgrade.
	const available: Record<PeerName, boolean> = { cortex: false, whisper: false };
	for (const peer of ["cortex", "whisper"] as PeerName[]) {
		if (!opts[peer]) continue; // opt-out
		const state = env.peers[peer];
		if (state.present) {
			const compat = deps.checkCompat(peer, state.version);
			if (compat.state === "below-min") deps.out(compat.guide); // guidance, NO upgrade
			deps.out(`✓ ${state.bin} already installed (${state.version ?? "version unknown"})`);
			available[peer] = true;
			continue;
		}
		const consent = opts.yes
			? true
			: interactive
				? await deps.askYesNo(`Install ${PKG[peer]}?`, true)
				: false;
		if (!consent) {
			deps.out(`skipped ${PKG[peer]} — install later with: ai-ezio init`);
			continue;
		}
		if (env.manager === null) {
			deps.out(`no package manager found — install manually: npm i -g ${PKG[peer]}`);
			continue;
		}
		const r = deps.installPeer(env.manager, PKG[peer]);
		if (r.ok) {
			deps.out(`installed ${PKG[peer]}`);
			available[peer] = true;
		} else {
			deps.out(`failed to install ${PKG[peer]}: ${r.error}`);
			for (const line of remediationFor(PKG[peer], r.error ?? "")) deps.out(line);
		}
	}

	// 2) Cortex mcp.json (ezio-owned) — only when opted-in AND available. Offer repair/
	// migration. applyCortex() may SKIP (returns false) when no entry resolves, so the
	// summary must reflect what actually happened (spec §5.2), not the intent.
	if (opts.cortex && available.cortex) {
		const kind = deps.classifyCortex();
		const unresolved =
			"could not resolve ai-cortex to a working mcp entry — see the guidance above";
		if (kind === "missing") {
			deps.out(deps.applyCortex() ? "added portable cortex entry to mcp.json" : unresolved);
		} else if (kind === "broken") {
			const repair = interactive
				? await deps.askYesNo("Repair the broken cortex mcp entry to the portable form?", true)
				: true;
			if (repair) deps.out(deps.applyCortex() ? "repaired cortex mcp entry" : unresolved);
			else deps.out("left the broken cortex entry as-is");
		} else if (kind === "valid-hardcoded") {
			const migrate = interactive
				? await deps.askYesNo(
						"Switch the hardcoded cortex path to the portable `ai-cortex mcp` form?",
						false,
					)
				: false;
			if (migrate)
				deps.out(deps.applyCortex() ? "migrated cortex entry to portable form" : unresolved);
			else deps.out("left your existing cortex entry untouched");
		} else {
			deps.out("cortex mcp entry already portable — unchanged");
		}
		for (const line of deps.cortexHookGuidance()) deps.out(line);
	}

	// 3) Whisper bridge — only when opted-in AND available. Dedicated profile consent.
	if (opts.whisper && available.whisper) {
		const consent = opts.yes
			? true
			: interactive
				? await deps.askYesNo(
						"Add AI_EZIO_HAX_BIN to your shell profile (so whisper can mount ezio)?",
						true,
					)
				: false;
		const bridge = deps.persistBridge(consent);
		deps.out(bridge.currentShellHint);
		if (bridge.transientEnvNote) deps.out(bridge.transientEnvNote);
		for (const line of deps.whisperPrereqGuidance()) deps.out(line);
	}

	deps.writeMarker();
	return 0;
}
