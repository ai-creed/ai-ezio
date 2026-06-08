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
import type { AssistantTurnFinishedEvent, StatusEvent } from "@ai-ezio/protocol";

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
