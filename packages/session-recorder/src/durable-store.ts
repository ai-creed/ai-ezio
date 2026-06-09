/** ezio's durable per-turn record — the source of truth (carries token usage).
 * Append-only JSONL at `<stateDir>/sessions/<repoKey>/<conversationId>.record.jsonl`. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DurableStore, RecordedTurn } from "./types.js";

export interface JsonlDurableStoreOptions {
	stateDir: string;
	repoKey: string;
}

export class JsonlDurableStore implements DurableStore {
	constructor(private readonly opts: JsonlDurableStoreOptions) {}

	private path(turn: RecordedTurn): string {
		return join(
			this.opts.stateDir,
			"sessions",
			this.opts.repoKey,
			`${turn.ref.conversationId}.record.jsonl`,
		);
	}

	append(turn: RecordedTurn): void {
		const p = this.path(turn);
		mkdirSync(dirname(p), { recursive: true });
		const row = {
			index: turn.index,
			userText: turn.userText,
			assistantText: turn.assistantText,
			toolCalls: turn.toolCalls,
			usage: turn.usage,
		};
		appendFileSync(p, `${JSON.stringify(row)}\n`);
	}
}
