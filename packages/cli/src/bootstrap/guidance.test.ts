import { describe, expect, it } from "vitest";
import { cortexHookGuidance, whisperPrereqGuidance } from "./guidance.js";
describe("guidance", () => {
	it("whisper prereq lists only what is missing", () => {
		const lines = whisperPrereqGuidance({
			hasAnthropicKey: false,
			hasClaude: true,
			hasCodex: false,
		});
		expect(lines.join("\n")).toContain("ANTHROPIC_API_KEY");
		expect(lines.join("\n")).toContain("codex");
		expect(lines.join("\n")).not.toContain("install claude"); // claude present
	});
	it("whisper prereq is empty when all present", () => {
		expect(
			whisperPrereqGuidance({ hasAnthropicKey: true, hasClaude: true, hasCodex: true }),
		).toEqual([]);
	});
	it("cortex hook guidance points at install-hooks + prompt-guide", () => {
		expect(cortexHookGuidance().join("\n")).toContain("ai-cortex history install-hooks");
		expect(cortexHookGuidance().join("\n")).toContain("ai-cortex memory install-prompt-guide");
	});
});
