/**
 * ezio-owned slash commands for the standalone REPL. A submitted `/`-command is
 * handled locally by ezio (rendered through ezio's own writer) and never reaches
 * the headless hax engine — hax's TUI slash commands write to a dead fd and the
 * mounted agent loop swallows them without emitting `idle`, which hangs the REPL.
 *
 * `classifyLine` is pure (testable without effects); `SlashController` owns the
 * registry + dispatch and is the extension point for future harness commands.
 */
import type { AssistantTurnFinishedEvent } from "@ai-ezio/protocol";
import { parseSessions, runResumePicker, type SessionRow } from "./resume-picker.js";

/** Structural facet of the harness Session the controller drives. Declared
 *  locally so @ai-ezio/surface need not depend on @ai-ezio/harness. */
export interface SlashSession {
	newConversation(): Promise<void>;
	status(): Promise<{ provider: string; model: string; effort?: string }>;
}
/** Structural facet of the session recorder. Optional in SlashContext. */
export interface SlashRecorder {
	noteNewConversation(): void;
}

/** What the REPL should do after the controller handles a line. */
export type SlashOutcome =
	| { action: "handled" } // command ran (or was unknown); do not submit
	| { action: "submit"; text: string } // not a command; submit to the engine
	| { action: "exit" }; // /quit — stop the REPL

/** Capabilities a command may use. Injected so the controller is unit-testable
 * and reusable outside standalone. */
export interface SlashContext {
	write(s: string): void;
	session: SlashSession;
	/** Optional session recorder — notified of the /new boundary so it rotates the
	 * conversation and does a final capture before the engine resets. */
	recorder?: SlashRecorder;
	/** Last assistant turn's content (event-tracked); "" if none yet. */
	lastContent(): string;
	/** Last assistant turn's usage (event-tracked); undefined if none yet. */
	lastUsage(): AssistantTurnFinishedEvent["usage"] | undefined;
	/** Discovered skills, for /skills (the `Skill` shape from skills.ts). */
	skills(): { name: string; source: string; description: string | null }[];
	/** Copy text to the OS clipboard; rejects when no clipboard tool exists. */
	clipboard(text: string): Promise<void>;
	/** Optional transcript view (Ctrl+T equivalent): pages hax's HAX_TRANSCRIPT
	 * mirror. Wired by the standalone runtime; undefined when unavailable. */
	showTranscript?: () => Promise<void>;
	/** Optional compaction trigger (M11; wired by the standalone runtime).
	 * Success/failure chrome comes from the Compactor's own onNote line. */
	compactor?: {
		compactNow(): Promise<{ kind: string; reason?: string }>;
	};
	/** §1C current session id (undefined until hax materializes it). */
	currentSessionId?: () => string | undefined;
	/** Read the effective title for the current session (pending or stored). */
	getSessionTitle?: () => string | undefined;
	/** Title the current session (buffers a pending rename when no id yet). */
	setSessionTitle?: (title: string) => void;
	/** Runtime-owned resume flow (list → pick → switch). See runResumeFlow. */
	resume?: () => Promise<void>;
}

export interface SlashCommand {
	name: string; // canonical, lowercase, bareword
	aliases?: string[];
	summary: string; // shown in /help
	run(ctx: SlashContext, args: string): Promise<void> | void;
}

export type LineClass =
	| { kind: "submit" }
	| { kind: "command"; name: string; args: string }
	| { kind: "unknown"; name: string };

const NAME_RE = /^[a-zA-Z][\w-]*$/;

/** Pure. Decide whether `line` is a command, an unknown command, or plain text
 * to submit. `known` contains every canonical name AND alias. Rules apply in
 * order; first match wins (see the spec's "Parsing semantics"). */
export function classifyLine(line: string, known: ReadonlySet<string>): LineClass {
	if (!line.startsWith("/")) return { kind: "submit" };
	if (line.includes("\n")) return { kind: "submit" };
	const body = line.slice(1);
	const ws = body.search(/\s/);
	const rawName = ws === -1 ? body : body.slice(0, ws);
	const args = ws === -1 ? "" : body.slice(ws).trim();
	if (rawName === "") return { kind: "submit" }; // "/" or "/ …"
	if (!NAME_RE.test(rawName)) return { kind: "submit" }; // "/tmp/foo", "/a.b" — path escape hatch
	const name = rawName.toLowerCase();
	return known.has(name) ? { kind: "command", name, args } : { kind: "unknown", name };
}

/** Render the /help listing: each command, then the keyboard shortcuts. */
function renderHelp(ctx: SlashContext, cmds: { name: string; summary: string }[]): void {
	for (const c of cmds) ctx.write(`  /${c.name}  ${c.summary}\n`);
	ctx.write(
		"\nshortcuts: Enter submit · Alt+Enter newline · paste multiline · Ctrl-C interrupt · Ctrl-D exit\n",
	);
}

/** Format the tracked per-turn usage, or null when nothing is reportable. */
function formatUsage(u: AssistantTurnFinishedEvent["usage"]): string | null {
	if (!u) return null;
	const parts: string[] = [];
	if (u.contextTokens !== undefined) parts.push(`context ${u.contextTokens}`);
	if (u.outputTokens !== undefined) parts.push(`output ${u.outputTokens}`);
	if (u.cachedTokens !== undefined) parts.push(`cached ${u.cachedTokens}`);
	if (u.contextLimit !== undefined) parts.push(`limit ${u.contextLimit}`);
	if (u.contextTokens !== undefined && u.contextLimit !== undefined && u.contextLimit > 0) {
		parts.push(`${Math.round((u.contextTokens / u.contextLimit) * 100)}%`);
	}
	return parts.length ? parts.join(" · ") : null;
}

/** The built-in command set (full parity minus /resume). `listCommands` is a
 * live view of the registry so /help reflects register()'d additions. */
function builtinCommands(listCommands: () => { name: string; summary: string }[]): SlashCommand[] {
	return [
		{
			name: "help",
			summary: "list commands and keyboard shortcuts",
			run: (ctx) => renderHelp(ctx, listCommands()),
		},
		{
			name: "new",
			aliases: ["clear"],
			summary: "start a new conversation",
			run: async (ctx) => {
				ctx.recorder?.noteNewConversation();
				await ctx.session.newConversation();
				ctx.write("— new conversation —\n");
			},
		},
		{
			name: "status",
			summary: "show provider, model, and effort",
			run: async (ctx) => {
				const s = await ctx.session.status();
				const effort = s.effort ? ` · ${s.effort}` : "";
				ctx.write(`${s.provider} · ${s.model}${effort}\n`);
			},
		},
		{
			name: "skills",
			summary: "list discovered skills",
			run: (ctx) => {
				const skills = ctx.skills();
				if (skills.length === 0) {
					ctx.write("(no skills found)\n");
					return;
				}
				for (const s of skills) ctx.write(`  ${s.name} · ${s.source}\n`);
			},
		},
		{
			name: "copy",
			summary: "copy the last response to the clipboard",
			run: async (ctx) => {
				const text = ctx.lastContent();
				if (text === "") {
					ctx.write("no response to copy\n");
					return;
				}
				try {
					await ctx.clipboard(text);
					ctx.write(`copied ${Buffer.byteLength(text, "utf8")} bytes\n`);
				} catch (e) {
					ctx.write(`clipboard unavailable: ${(e as Error).message}\n`);
				}
			},
		},
		{
			name: "usage",
			summary: "show the last turn's token usage",
			run: (ctx) => {
				const formatted = formatUsage(ctx.lastUsage());
				ctx.write(formatted ? `${formatted}\n` : "no usage yet\n");
			},
		},
		{
			name: "transcript",
			summary: "view the model-perspective transcript (same as Ctrl+T)",
			run: async (ctx) => {
				if (!ctx.showTranscript) {
					ctx.write("transcript unavailable\n");
					return;
				}
				await ctx.showTranscript();
			},
		},
		{
			name: "compact",
			summary: "summarize old history and free context",
			run: async (ctx) => {
				if (!ctx.compactor) {
					ctx.write("compaction unavailable\n");
					return;
				}
				const out = await ctx.compactor.compactNow();
				if (out.kind === "skipped" && out.reason === "in-progress") {
					ctx.write("compaction already in progress\n");
				}
				// success/failure chrome comes from the Compactor's onNote line
			},
		},
		{
			name: "rename",
			summary: "set a friendly title for this session (shown in /resume)",
			run: (ctx, args) => {
				if (!ctx.setSessionTitle) {
					ctx.write("rename unavailable\n");
					return;
				}
				const title = args.trim();
				if (title === "") {
					const current = ctx.getSessionTitle?.();
					ctx.write(current ? `${current}\n` : "no title set · usage: /rename <text>\n");
					return;
				}
				ctx.setSessionTitle(title);
				ctx.write(`— renamed to "${title}" —\n`);
			},
		},
		{
			name: "resume",
			summary: "switch to a past session in this folder",
			run: async (ctx) => {
				if (!ctx.resume) {
					ctx.write("resume unavailable\n");
					return;
				}
				await ctx.resume();
			},
		},
		{
			name: "quit",
			aliases: ["exit"],
			summary: "exit ezio",
			run: () => {}, // the controller maps /quit to the exit outcome before run()
		},
	];
}

/** Owns the command registry + dispatch. The unit the REPL drives, and the
 * extension point: call register() to add harness-purpose commands later. */
export class SlashController {
	private readonly ctx: SlashContext;
	/** name OR alias → command (so classifyLine's `known` set is keys()). */
	private readonly byKey = new Map<string, SlashCommand>();

	constructor(ctx: SlashContext, opts?: { excludeCommands?: readonly string[] }) {
		this.ctx = ctx;
		const exclude = new Set(opts?.excludeCommands ?? []);
		for (const cmd of builtinCommands(() => this.summaries())) {
			if (exclude.has(cmd.name)) continue; // drops the command AND its aliases
			this.register(cmd);
		}
	}

	/** Register (or override) a command and its aliases. Last registration wins
	 * per key: any command that already owns this command's NAME is fully evicted
	 * (all of its keys removed) so an override replaces it cleanly; an alias key
	 * collision is resolved key-by-key (the alias now points at the new command,
	 * but the prior owner keeps its other keys). */
	register(cmd: SlashCommand): void {
		const displaced = this.byKey.get(cmd.name);
		if (displaced) {
			for (const [k, v] of this.byKey) if (v === displaced) this.byKey.delete(k);
		}
		this.byKey.set(cmd.name, cmd);
		for (const a of cmd.aliases ?? []) this.byKey.set(a, cmd);
	}

	/** Deduped canonical command list for /help. A command is listed only if it
	 * still OWNS its own name key — this filters out any command reachable only
	 * through a stolen alias key (e.g. another command claimed its name), so
	 * /help never shows a stale entry. */
	private summaries(): { name: string; summary: string }[] {
		const seen = new Set<SlashCommand>();
		const out: { name: string; summary: string }[] = [];
		for (const cmd of this.byKey.values()) {
			if (seen.has(cmd)) continue;
			seen.add(cmd);
			if (this.byKey.get(cmd.name) !== cmd) continue; // reachable only via a stolen alias
			out.push({ name: cmd.name, summary: cmd.summary });
		}
		return out;
	}

	async handle(line: string): Promise<SlashOutcome> {
		const c = classifyLine(line, new Set(this.byKey.keys()));
		if (c.kind === "submit") return { action: "submit", text: line };
		if (c.kind === "unknown") {
			this.ctx.write(`unknown command: /${c.name}. type /help for the list.\n`);
			return { action: "handled" };
		}
		const cmd = this.byKey.get(c.name);
		if (!cmd) return { action: "handled" }; // unreachable: known set came from byKey
		if (cmd.name === "quit") return { action: "exit" };
		try {
			await cmd.run(this.ctx, c.args);
		} catch (e) {
			this.ctx.write(`/${c.name} failed: ${(e as Error).message}\n`);
		}
		return { action: "handled" };
	}
}

export interface ResumeFlowDeps {
	write(s: string): void;
	/** True while a turn is in flight (a respawn would drop it). */
	isBusy(): boolean;
	/** Raw `hax --list-sessions` JSON (impure; per-runtime). */
	listSessions(): Promise<string>;
	/** id → title sidecar, merged into the picker rows. */
	titles(): Map<string, string>;
	/** The live session id (excluded from the list); undefined excludes nothing. */
	currentSessionId(): string | undefined;
	/** Per-mode raw-input overlay: provides the picker a raw key stream. */
	runOverlay(
		run: (io: {
			keys: AsyncIterable<string>;
			write(s: string): void;
			setRawMode(on: boolean): void;
		}) => Promise<void>,
	): Promise<void>;
	/** Engine respawn + post-respawn re-wiring (per-runtime). Rejects (engine left
	 * closed) on bad id / spawn / protocol failure — see onFatal. */
	resume(id: string): Promise<void>;
	/** Tear down the REPL (standalone) / pane (mounted) cleanly. Called ONLY after a
	 * respawn failure: the old engine is already closed and cannot be revived, so per
	 * spec §4 we "report and exit cleanly" with no fresh fallback. */
	onFatal(): void;
	now(): number;
}

/** Shared `/resume` orchestration (§3): busy-guard → list+merge → exclude active
 * → arrow-pick over the runtime overlay → switch. Per-mode primitives injected. */
export async function runResumeFlow(deps: ResumeFlowDeps): Promise<void> {
	if (deps.isBusy()) {
		deps.write("finish or interrupt the current turn first\n");
		return;
	}
	const titles = deps.titles();
	const active = deps.currentSessionId();
	const rows: SessionRow[] = parseSessions(await deps.listSessions()).filter(
		(r) => r.id !== active,
	);
	if (rows.length === 0) {
		deps.write("no other sessions in this folder\n");
		return;
	}
	let chosen: string | undefined;
	await deps.runOverlay(async (io) => {
		chosen = await runResumePicker({
			listSessions: async () => JSON.stringify(rows), // already parsed+filtered; re-serialize for the picker
			keys: io.keys,
			write: io.write,
			now: deps.now,
			setRawMode: io.setRawMode,
			titles,
		});
	});
	if (!chosen) return; // cancel / nothing selected → no-op
	try {
		await deps.resume(chosen);
	} catch (e) {
		// A gate-held rejection (a turn/compaction grabbed the gate between the busy
		// guard and the respawn) is RECOVERABLE — Session.resume left the session
		// untouched. Report it as busy and leave the pane/REPL intact; do NOT call
		// onFatal (which would tear it down). Matched by error name so surface keeps
		// no dependency on @ai-ezio/harness. This is the same outcome as the up-front
		// isBusy() guard, just from the harness backstop.
		if ((e as Error).name === "EngineBusyError") {
			deps.write("finish or interrupt the current turn first\n");
			return;
		}
		// Spec §4: a real respawn failure leaves the old session closed and
		// unrevivable. Report and exit cleanly — NO fresh fallback. onFatal hands the
		// engine-exit/teardown to the runtime (standalone REPL or mounted pane).
		deps.write(`resume failed: ${(e as Error).message}\n`);
		deps.onFatal();
	}
}
