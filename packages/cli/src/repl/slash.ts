/**
 * ezio-owned slash commands for the standalone REPL. A submitted `/`-command is
 * handled locally by ezio (rendered through ezio's own writer) and never reaches
 * the headless hax engine — hax's TUI slash commands write to a dead fd and the
 * mounted agent loop swallows them without emitting `idle`, which hangs the REPL.
 *
 * `classifyLine` is pure (testable without effects); `SlashController` owns the
 * registry + dispatch and is the extension point for future harness commands.
 */
import type { Session } from "@ai-ezio/harness";
import type { AssistantTurnFinishedEvent } from "@ai-ezio/protocol";
import type { SessionRecorder } from "@ai-ezio/session-recorder";

/** What the REPL should do after the controller handles a line. */
export type SlashOutcome =
	| { action: "handled" } // command ran (or was unknown); do not submit
	| { action: "submit"; text: string } // not a command; submit to the engine
	| { action: "exit" }; // /quit — stop the REPL

/** Capabilities a command may use. Injected so the controller is unit-testable
 * and reusable outside standalone. */
export interface SlashContext {
	write(s: string): void;
	session: Pick<Session, "newConversation" | "status">;
	/** Optional session recorder — notified of the /new boundary so it rotates the
	 * conversation and does a final capture before the engine resets. */
	recorder?: Pick<SessionRecorder, "noteNewConversation">;
	/** Last assistant turn's content (event-tracked); "" if none yet. */
	lastContent(): string;
	/** Last assistant turn's usage (event-tracked); undefined if none yet. */
	lastUsage(): AssistantTurnFinishedEvent["usage"] | undefined;
	/** Discovered skills, for /skills (the `Skill` shape from skills.ts). */
	skills(): { name: string; source: string; description: string | null }[];
	/** Copy text to the OS clipboard; rejects when no clipboard tool exists. */
	clipboard(text: string): Promise<void>;
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

	constructor(ctx: SlashContext) {
		this.ctx = ctx;
		for (const cmd of builtinCommands(() => this.summaries())) this.register(cmd);
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
