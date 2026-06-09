/** AI_EZIO_HAX_BIN bridge: a stable ezio-owned symlink + a single managed export
 * block. Persistence is decided by the PROFILE, never the process env (A/C); the
 * value is shell-escaped (B). */
import { shellSingleQuote } from "./shell.js";

export const BEGIN = "# >>> ai-ezio (managed) >>>";
export const END = "# <<< ai-ezio <<<";

export function renderManagedBlock(target: string): string {
	return `${BEGIN}\nexport AI_EZIO_HAX_BIN=${shellSingleQuote(target)}\n${END}`;
}
export function upsertManagedBlock(profileText: string, target: string): string {
	const block = renderManagedBlock(target);
	const b = profileText.indexOf(BEGIN);
	const e = profileText.indexOf(END);
	if (b >= 0 && e > b) return profileText.slice(0, b) + block + profileText.slice(e + END.length);
	const sep = profileText.length > 0 && !profileText.endsWith("\n") ? "\n" : "";
	const lead = profileText.length > 0 ? "\n" : "";
	return `${profileText}${sep}${lead}${block}\n`;
}
export function hasUserOwnedExport(profileText: string): boolean {
	const b = profileText.indexOf(BEGIN);
	const e = profileText.indexOf(END);
	const stripped =
		b >= 0 && e > b ? profileText.slice(0, b) + profileText.slice(e + END.length) : profileText;
	// Only a real `export` is inherited by child processes (whisper's check), so a
	// bare `AI_EZIO_HAX_BIN=…` assignment is NOT durable and must not suppress the
	// managed block (finding 3).
	return stripped.split("\n").some((l) => /^export\s+AI_EZIO_HAX_BIN=/.test(l.trim()));
}

export interface BridgeDeps {
	resolveHax: () => string; // throws if unresolvable -> caller maps to §6 error
	symlinkPath: () => string;
	ensureSymlink: (target: string, link: string) => void;
	profilePath: () => string | null;
	readFile: (path: string) => string | null;
	writeFile: (path: string, text: string) => void;
	env: NodeJS.ProcessEnv;
}
export interface BridgeResult {
	action: "created" | "updated" | "left-user-owned" | "declined" | "no-profile";
	currentShellHint: string;
	transientEnvNote?: string;
}

export function persistBridge(consent: boolean, deps: BridgeDeps): BridgeResult {
	const real = deps.resolveHax();
	const link = deps.symlinkPath();
	deps.ensureSymlink(real, link);
	const exportLine = `export AI_EZIO_HAX_BIN=${shellSingleQuote(link)}`;
	const transient = deps.env.AI_EZIO_HAX_BIN
		? "Note: the current AI_EZIO_HAX_BIN is temporary and will be superseded by the durable managed export."
		: undefined;
	const profile = deps.profilePath();
	if (profile === null)
		return {
			action: "no-profile",
			currentShellHint: `Add to your shell profile: ${exportLine}`,
			transientEnvNote: transient,
		};
	// The printed `source <profile>` is a copy-paste command, so the PATH must be
	// shell-escaped too (not just the export value) — a HOME with spaces otherwise
	// truncates it and the command exits 127 (shell-safe current-shell action, §5.4).
	const sourceHint = `Run \`source ${shellSingleQuote(profile)}\` (or open a new terminal), then \`whisper collab mount ezio\`.`;
	const current = deps.readFile(profile) ?? "";
	if (hasUserOwnedExport(current))
		return { action: "left-user-owned", currentShellHint: sourceHint, transientEnvNote: transient };
	if (!consent)
		return {
			action: "declined",
			currentShellHint: `To wire future shells, add to ${shellSingleQuote(profile)}: ${exportLine}`,
			transientEnvNote: transient,
		};
	const had = current.includes(BEGIN);
	deps.writeFile(profile, upsertManagedBlock(current, link));
	return {
		action: had ? "updated" : "created",
		currentShellHint: sourceHint,
		transientEnvNote: transient,
	};
}
