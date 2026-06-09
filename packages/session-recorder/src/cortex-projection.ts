/** Project a neutral turn into the two Claude-format JSONL lines cortex's parser
 * consumes (ai-cortex/src/lib/history/compact.ts). `startTurnNo` is the running line
 * counter; each turn consumes two line numbers (user, assistant). */
import type { RecordedTurn } from "./types.js";

export function renderCortexLines(turn: RecordedTurn, startTurnNo: number): string[] {
	const userLine = {
		type: "user",
		turn: startTurnNo,
		message: { content: [{ type: "text", text: turn.userText }] },
	};

	const assistantContent: Array<Record<string, unknown>> = [
		{ type: "text", text: turn.assistantText },
	];
	for (const tc of turn.toolCalls) {
		assistantContent.push({ type: "tool_use", name: tc.name, input: tc.input ?? {} });
	}
	const assistantLine = {
		type: "assistant",
		turn: startTurnNo + 1,
		message: { content: assistantContent },
	};

	return [JSON.stringify(userLine), JSON.stringify(assistantLine)];
}
