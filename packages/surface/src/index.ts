/**
 * @ai-ezio/surface — ezio's presentation surface: the robust markdown renderer
 * and the mounted pane renderer, plus the shared ANSI palette. Consumed by
 * ai-whisper's adapter-ai-ezio today and by the future standalone `ezio --rich`.
 */
export { renderMarkdown } from "./render-markdown.js";
export { createMountedRenderer } from "./mounted-renderer.js";
export * as style from "./style.js";
export {
	discoverSkills,
	nodeSkillFs,
	skillDirs,
	type Skill,
	type SkillDir,
	type SkillEnv,
} from "./skills.js";
export { makeClipboard } from "./clipboard.js";
export {
	resolvePager,
	showTranscript,
	transcriptFilePath,
	type TranscriptViewDeps,
} from "./transcript-view.js";
export {
	classifyLine,
	SlashController,
	type SlashCommand,
	type SlashContext,
	type SlashOutcome,
	type SlashSession,
	type SlashRecorder,
	type LineClass,
} from "./slash.js";
