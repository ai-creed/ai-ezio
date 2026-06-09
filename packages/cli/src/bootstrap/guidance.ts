/** Guidance for prerequisites ezio cannot supply (spec §6, §10): whisper's
 * ANTHROPIC_API_KEY + claude/codex CLIs, and cortex's optional claude/codex hooks. */
export interface WhisperPrereqs {
	hasAnthropicKey: boolean;
	hasClaude: boolean;
	hasCodex: boolean;
}
export function whisperPrereqGuidance(p: WhisperPrereqs): string[] {
	const lines: string[] = [];
	if (!p.hasAnthropicKey)
		lines.push("whisper: set ANTHROPIC_API_KEY (its default evaluator) — see ai-whisper README.");
	if (!p.hasClaude)
		lines.push("whisper: install + authenticate the `claude` CLI (whisper spawns it).");
	if (!p.hasCodex)
		lines.push("whisper: install + authenticate the `codex` CLI (whisper spawns it).");
	return lines;
}
export function cortexHookGuidance(): string[] {
	return [
		"cortex (optional, for claude/codex users): `ai-cortex history install-hooks` to capture their sessions,",
		"and `ai-cortex memory install-prompt-guide`. Not needed for ezio itself.",
	];
}
