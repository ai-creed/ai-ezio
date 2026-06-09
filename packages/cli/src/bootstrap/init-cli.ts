/** Real collaborators for runInit + the first-run dispatcher + doctor's wired
 * state. Kept apart from init.ts so the orchestrator stays pure-dep. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { describeHaxBinary, resolveHaxBinary } from "@ai-ezio/harness";
import { configPath } from "@ai-ezio/mcp-host";
import { BEGIN, hasUserOwnedExport, persistBridge } from "./bridge.js";
import { detectEnvironment, type Environment, parseGlobalList } from "./detect.js";
import { cortexHookGuidance, whisperPrereqGuidance } from "./guidance.js";
import { type InitDeps, parseInitArgs, runInit } from "./init.js";
import { installPeer } from "./install-peers.js";
import { writeMarker } from "./marker.js";
import { bridgeSymlinkPath } from "./paths.js";
import { askYesNo, nodePromptIO } from "./prompt.js";
import {
	applyCortex,
	classifyCortex,
	cortexEntry,
	type CortexEntry,
	cortexEntryLaunches,
	nextBackupPath,
	parseMcp,
	serializeMcp,
} from "./reconcile-mcp.js";
import { checkCompat } from "./versions.js";

/** Tags an fs failure inside a bridge dep so persistBridge's wrapper can render it
 * as non-fatal guidance (finding 1, §6) while keeping bridge.ts dep-pure. */
class BridgeFsError extends Error {
	constructor(message: string, cause: unknown) {
		super(`${message}: ${(cause as Error)?.message ?? String(cause)}`);
		this.name = "BridgeFsError";
	}
}

function which(cmd: string): string | null {
	try {
		return (
			execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim() || null
		);
	} catch {
		return null;
	}
}
function versionOf(bin: string): string | null {
	try {
		return (
			execFileSync(bin, ["--version"], { encoding: "utf8" }).match(/\d+\.\d+\.\d+/)?.[0] ?? null
		);
	} catch {
		return null;
	}
}
function globalList(manager: "npm" | "pnpm"): string[] {
	try {
		// parseGlobalList handles npm's object vs pnpm's array shape (detect.ts, tested).
		return parseGlobalList(
			execFileSync(manager, ["ls", "-g", "--depth=0", "--json"], { encoding: "utf8" }),
		);
	} catch {
		return [];
	}
}
function chosenProfile(env: NodeJS.ProcessEnv): string | null {
	const shell = env.SHELL ?? "";
	const home = env.HOME ?? homedir();
	if (shell.includes("zsh")) return `${home}/.zshrc`;
	// macOS login bash sources ~/.bash_profile, NOT ~/.bashrc; Linux sources ~/.bashrc
	// for interactive shells. Pick the file a login shell actually reads (finding 4).
	if (shell.includes("bash"))
		return process.platform === "darwin" ? `${home}/.bash_profile` : `${home}/.bashrc`;
	return null; // ambiguous -> bridge prints the export line
}
function detect(env: NodeJS.ProcessEnv): Environment {
	return detectEnvironment({
		which,
		versionOf,
		globalList,
		isTTY: () => Boolean(process.stdin.isTTY),
		env,
	});
}

/** Resolve the cortex entry to WRITE: portable `ai-cortex mcp` when on PATH, else
 * a resolved-node fallback locating ai-cortex's cli.js under a manager's global
 * root (spec §5.4 — covers global-list-only installs not on PATH). */
function globalRoot(manager: "npm" | "pnpm"): string | null {
	try {
		return execFileSync(manager, ["root", "-g"], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}
function resolveCortexEntry(): CortexEntry | null {
	const onPath = which("ai-cortex") !== null;
	let nodeCli: string | null = null;
	if (!onPath) {
		for (const m of ["npm", "pnpm"] as const) {
			const root = globalRoot(m);
			const candidate = root ? `${root}/ai-cortex/dist/src/cli.js` : null;
			if (candidate && existsSync(candidate)) {
				nodeCli = candidate;
				break;
			}
		}
	}
	return cortexEntry(onPath, nodeCli); // null when neither resolves
}
/** Wire real seams into the pure cortexEntryLaunches classifier — path commands,
 * `node <script>`, and bare PATH commands are each handled, so a valid existing
 * entry (e.g. an absolute-path command) is never misclassified as broken. */
function cortexEntryWorks(e: { command: string; args?: string[] }): boolean {
	return cortexEntryLaunches(e, { onPath: (c) => which(c) !== null, fileExists: existsSync });
}
function loadMcp(env: NodeJS.ProcessEnv) {
	const path = configPath(env);
	const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
	return { path, raw, parsed: parseMcp(raw) };
}

export async function runInitCli(argv: string[]): Promise<number> {
	const env = process.env;
	if (!describeHaxBinary().ok) {
		process.stderr.write('ai-ezio: hax engine not found — run "ai-ezio doctor".\n');
		return 1;
	}
	const io = nodePromptIO();
	const deps: InitDeps = {
		detect: () => detect(env),
		checkCompat,
		askYesNo: (q, d) => askYesNo(io, q, d),
		installPeer: (manager, pkg) =>
			installPeer(manager, pkg, {
				run: (cmd, args) => {
					try {
						execFileSync(cmd, args, { stdio: "inherit" });
						return { ok: true };
					} catch (e) {
						return { ok: false, stderr: (e as Error).message };
					}
				},
			}),
		classifyCortex: () => {
			const { parsed } = loadMcp(env);
			// A present-but-unparseable mcp.json is "malformed" (always backed up, never
			// declined) — distinct from a parseable-but-non-launching entry ("broken").
			return parsed.ok ? classifyCortex(parsed.obj, { entryWorks: cortexEntryWorks }) : "malformed";
		},
		applyCortex: () => {
			const { path, raw, parsed } = loadMcp(env);
			// CRITICAL (finding 2): a malformed file is backed up BEFORE we decide whether
			// the cortex entry resolves, so data is never lost even when we then bail to
			// guidance. mkdir + backup + writes are guarded so an fs error degrades to a
			// non-fatal guidance line instead of crashing first-run (finding 1, §6).
			try {
				mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
				if (!parsed.ok && raw !== null) writeFileSync(nextBackupPath(path, existsSync), raw); // collision-safe, never lose data
				const entry = resolveCortexEntry(); // portable, resolved-node fallback, or null
				if (!entry) {
					process.stderr.write(
						"ai-ezio: ai-cortex is installed but not on PATH and its cli.js could not be located — add ai-cortex to PATH, then run `ai-ezio init --reconfigure`.\n",
					);
					return false; // skipped -> runInit prints an accurate "could not resolve" summary
				}
				writeFileSync(path, serializeMcp(applyCortex(parsed.ok ? parsed.obj : {}, entry)));
				return true;
			} catch (e) {
				process.stderr.write(
					`ai-ezio: could not write ${path}: ${(e as Error).message} — fix permissions, then run \`ai-ezio init --reconfigure\`.\n`,
				);
				return false; // skipped -> accurate "could not resolve" summary, never thrown
			}
		},
		persistBridge: (consent) => {
			// fs mutations degrade to guidance, not a crash (finding 1, §6): the symlink and
			// profile writes throw a tagged BridgeFsError, which is caught here and turned
			// into a non-fatal guidance result rather than letting EACCES escape uncaught.
			try {
				return persistBridge(consent, {
					resolveHax: resolveHaxBinary,
					symlinkPath: () => bridgeSymlinkPath(env),
					ensureSymlink: (target, link) => {
						try {
							mkdirSync(link.replace(/\/[^/]+$/, ""), { recursive: true });
							rmSync(link, { force: true });
							symlinkSync(target, link);
						} catch (e) {
							throw new BridgeFsError(`could not create the ezio hax symlink at ${link}`, e);
						}
					},
					profilePath: () => chosenProfile(env),
					readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
					writeFile: (p, s) => {
						try {
							writeFileSync(p, s);
						} catch (e) {
							throw new BridgeFsError(`could not write ${p}`, e);
						}
					},
					env,
				});
			} catch (e) {
				const detail = e instanceof BridgeFsError ? e.message : (e as Error).message;
				return {
					action: "no-profile",
					currentShellHint: `ai-ezio: ${detail} — fix permissions, then run \`ai-ezio init --reconfigure\`.`,
				};
			}
		},
		whisperPrereqGuidance: () =>
			whisperPrereqGuidance({
				hasAnthropicKey: Boolean(env.ANTHROPIC_API_KEY),
				hasClaude: which("claude") !== null,
				hasCodex: which("codex") !== null,
			}),
		cortexHookGuidance,
		writeMarker: () => {
			// A read-only config dir must not crash the wizard — degrade to guidance so the
			// REPL still launches (finding 1, §6). Worst case the marker is missing and the
			// next bare launch re-offers, which is idempotent.
			try {
				writeMarker(env, {
					mkdirp: (d) => mkdirSync(d, { recursive: true }),
					writeFile: (p, s) => writeFileSync(p, s),
				});
			} catch (e) {
				process.stderr.write(
					`ai-ezio: could not write the bootstrap marker: ${(e as Error).message} — first-run setup may re-offer next launch.\n`,
				);
			}
		},
		out: (line) => process.stdout.write(`${line}\n`),
	};
	return runInit(parseInitArgs(argv), deps);
}

/** Read-only wired state for `ai-ezio doctor`. Durability is decided by the
 * PROFILE (managed marker or user-owned export), NOT symlink existence. */
export function computeWiredState(env: NodeJS.ProcessEnv = process.env) {
	const e = detect(env);
	const { parsed } = loadMcp(env);
	const cortexConfigured = parsed.ok && Boolean(parsed.obj.mcpServers?.cortex);
	const profile = chosenProfile(env);
	const text = profile && existsSync(profile) ? readFileSync(profile, "utf8") : "";
	const bridgePersisted = text.includes(BEGIN) || hasUserOwnedExport(text);
	return {
		cortexConfigured,
		bridgePersisted,
		peers: { cortex: e.peers.cortex.present, whisper: e.peers.whisper.present },
	};
}
